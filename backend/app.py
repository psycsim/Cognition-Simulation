"""
Flask application for handling LLM evaluation and response analysis.

This application provides an API endpoint for evaluating LLM responses using various metrics
and storing the results in Supabase. It integrates with Google's Gemini API for LLM operations
and handles CORS for both development and production environments.
"""

from flask import Flask, Blueprint, request, jsonify
from flask_restful import Api, Resource
from dotenv import load_dotenv
from flask_cors import CORS
import os
from supabase import create_client, Client
from pathlib import Path
from langchain_core.messages import SystemMessage, HumanMessage
# from utils.cosine_sim import *
from utils.simulation import *
from utils.evaluate import *
from utils.graph import normalize_graph, validate_graph
from utils.sampling import generate_personas, personas_match
from utils.llm import get_llm, resolve_model_name, DEFAULT_MODEL
from utils.progress import create_progress_updater
from utils.llm import extract_usage
from utils.pricing import (
    compute_prompt_and_eval_cost,
    compute_cost,
    estimate_run_cost,
    pricing_params,
    CREDITS_PER_USD,
    MIN_BALANCE_USD,
    RUN_FEE_USD,
)
from utils.prompts import (
    GENERATE_STEPS_SYSTEM_PROMPT,
    get_generate_steps_user_prompt,
    PARSE_PDF_SYSTEM_PROMPT,
    get_parse_pdf_user_prompt
)
import base64
import threading
import uuid
import json
import re
import logging
import stripe
import typing_extensions as typing
from datetime import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


# Load environment variables from .env file
load_dotenv()

# Initialize Flask application
app = Flask(__name__)

# Determine if running in development or production mode
prod = os.environ.get("DEV") or 'production'

# Configure CORS based on environment
if prod == 'development':
    # Development CORS settings - allow localhost:3000
    CORS(app, resources={
        r"/api/*": {"origins": "http://localhost:3000",
                    "methods": ["GET", "POST", "OPTIONS"],
                    "allow_headers": ["Content-Type", "Authorization"]}})
else:
    # Production CORS settings - allow Vercel deployment and custom domains
    CORS(app, resources={
        r"/api/*": {
            "origins": [
                "https://cognition-simulation-e9on.vercel.app",
                "https://psycsim.com",
                "https://www.psycsim.com",
                "https://psycsim.org",
                "https://www.psycsim.org"
            ],
            "methods": ["GET", "POST", "OPTIONS"],
            "allow_headers": ["Content-Type", "Authorization"],
            "supports_credentials": True
        }
    })

# Initialize API blueprint and RESTful API
api_bp = Blueprint("api", __name__)
api = Api(api_bp)


# Configure Supabase connection
url: str = os.environ.get("VITE_SUPABASE_URL")
key: str = os.environ.get("VITE_SUPABASE_KEY")

# Load environment variables from .env file
env_path = Path('.') / '.env'
load_dotenv(dotenv_path=env_path)

# Service-role key for trusted server-side writes (e.g. crediting purchases).
# This bypasses RLS, so it must NEVER be exposed to clients.
service_key: str = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# Function to create a Supabase client with optional JWT authentication
def get_supabase_client(jwt=None):
    """
    Create a Supabase client instance with optional JWT authentication.
    This ensures each request gets its own client to avoid concurrency issues.
    """
    client = create_client(url, key)
    if jwt:
        client.auth.set_session(jwt, "")
    return client


def get_service_client():
    """
    Create a Supabase client using the service-role key. Bypasses RLS so the
    backend can update protected columns (like user_emails.credits). Returns None
    if the service key isn't configured.
    """
    if not service_key:
        return None
    return create_client(url, service_key)


def credit_user_account(user_id, amount, session):
    """
    Add `amount` credits to user_emails.credits for `user_id`, idempotently.

    Idempotency: once a Stripe session has been credited we stamp its metadata
    with credited="true", so repeated verify calls (e.g. a page refresh) never
    double-credit the same payment.

    Returns the new credit balance, or None if it could not be applied.
    """
    client = get_service_client()
    if client is None:
        logger.error("SUPABASE_SERVICE_ROLE_KEY not set; cannot credit user %s.", user_id)
        return None

    # metadata is a StripeObject; use its to_dict() for a plain dict (dict() and
    # .get() don't work on StripeObject).
    md = session.metadata.to_dict() if session.metadata else {}

    # Already credited this session — return the current balance unchanged.
    if md.get("credited") == "true":
        balance = get_balance(user_id)
        return round(balance["paid"], 2) if balance else None

    # Atomic increment in Postgres (see supabase/migrations/*_credits.sql).
    result = client.rpc("add_paid_credits", {"p_user_id": user_id, "p_amount": float(amount)}).execute()
    new_balance = result.data if not isinstance(result.data, list) else (result.data[0] if result.data else None)
    if isinstance(new_balance, dict):
        new_balance = next(iter(new_balance.values()), None)

    # Stamp the session so it can't be credited again.
    try:
        stripe.checkout.Session.modify(session.id, metadata={**md, "credited": "true"})
    except Exception as e:
        logger.warning("Could not mark session %s credited: %s", session.id, e)

    return round(float(new_balance), 2) if new_balance is not None else None


# ---------------------------------------------------------------------------
# Credits / billing helpers
# ---------------------------------------------------------------------------

def get_verified_user_id(jwt):
    """Return the Supabase auth user id for a JWT, or None if invalid/missing."""
    if not jwt:
        return None
    try:
        client = get_service_client() or create_client(url, key)
        resp = client.auth.get_user(jwt)
        user = getattr(resp, "user", None)
        return user.id if user else None
    except Exception as e:
        logger.warning("Could not verify user JWT: %s", e)
        return None


def jwt_from_request():
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header.split("Bearer ")[1]
    return None


def get_balance(user_id):
    """Return {"free", "paid", "total"} in USD for a user, or None on failure."""
    client = get_service_client()
    if client is None or not user_id:
        return None
    try:
        row = client.table("user_emails").select("credits, free_credits").eq("user_id", user_id).execute()
    except Exception as e:
        logger.error("Could not read balance for %s: %s", user_id, e)
        return None
    if not row.data:
        return {"free": 0.0, "paid": 0.0, "total": 0.0}
    free = float(row.data[0].get("free_credits") or 0)
    paid = float(row.data[0].get("credits") or 0)
    return {"free": free, "paid": paid, "total": free + paid}


def reserved_for_running(user_id, exclude_experiment_id=None):
    """Sum of expected cost of this user's runs that are still in progress."""
    client = get_service_client()
    if client is None:
        return 0.0
    try:
        rows = client.table("experiments").select("experiment_id, experiment_data") \
            .eq("user_id", user_id).eq("status", "Started").execute().data or []
    except Exception as e:
        logger.warning("Could not read running experiments for %s: %s", user_id, e)
        return 0.0
    total = 0.0
    for r in rows:
        if exclude_experiment_id and r.get("experiment_id") == exclude_experiment_id:
            continue
        d = r.get("experiment_data") or {}
        if isinstance(d, str):
            try:
                d = json.loads(d)
            except ValueError:
                d = {}
        steps = d.get("steps") or []
        total += estimate_run_cost(d.get("iters") or 10, len(steps) if isinstance(steps, list) else 0)["expected"]
    return total


def charge_user(user_id, amount_usd):
    """
    Atomically deduct `amount_usd` from the user's balance (free credits first).
    Returns {"free_portion", "paid_portion"} or None if the charge failed.
    """
    client = get_service_client()
    if client is None or not user_id or amount_usd <= 0:
        return None
    try:
        result = client.rpc("charge_user", {"p_user_id": user_id, "p_amount": float(amount_usd)}).execute()
        row = result.data[0] if isinstance(result.data, list) and result.data else result.data
        if not row:
            logger.error("charge_user returned no row for %s (user missing?)", user_id)
            return None
        return {
            "free_portion": float(row.get("free_portion") or 0),
            "paid_portion": float(row.get("paid_portion") or 0),
        }
    except Exception as e:
        logger.error("Failed to charge %s $%.6f: %s", user_id, amount_usd, e)
        return None


def charge_and_record(user_id, token_row_id, amount_usd):
    """Charge the user and stamp the tokens row with what was actually deducted."""
    charged = charge_user(user_id, amount_usd)
    if charged is None:
        return None
    try:
        get_service_client().table("tokens").update({
            "charged_amount": round(amount_usd, 6),
            "free_portion": round(charged["free_portion"], 6),
        }).eq("id", token_row_id).execute()
    except Exception as e:
        logger.warning("Charged %s but could not record on tokens row %s: %s", user_id, token_row_id, e)
    return charged


# Keep GEMINI_KEY available for reference; get_llm() reads it from env directly.
key_g = os.environ.get('GEMINI_KEY')

# Stripe configuration. The secret key lives only on the backend.
stripe.api_key = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_CURRENCY = "usd"
STRIPE_MIN_AMOUNT = 1       # $1
STRIPE_MAX_AMOUNT = 10000   # $10,000


def run_evaluation(uuid, data, model_name, jwt=None):
    fn = None  # Initialize fn variable for cleanup
    try:
        # Create a new Supabase client for this request
        supabase = get_supabase_client(jwt)

        # Resolve the step graph before doing any work. Legacy experiments have
        # no graph keys and normalize into a straight chain.
        ordered_steps, step_parents, step_children = normalize_graph(data.get('steps', []))
        graph_errors = validate_graph(ordered_steps, step_parents, step_children)
        if graph_errors:
            raise ValueError("Invalid simulation design: " + " ".join(graph_errors))
        data = {**data, 'steps': ordered_steps}

        # Number of sample rows (personas) to use for this run: from request, clamped to 10-50
        num_samples = data.get('iters', 10)
        try:
            num_samples = max(10, min(50, int(num_samples)))
        except (TypeError, ValueError):
            num_samples = 10

        # Build exactly num_samples personas matching the sample's distributions.
        # The last set is cached on the sample and reused while it still matches
        # the current attributes and size; editing a distribution invalidates it.
        sample_id = data.get('sample')['id']
        attributes = data.get('sample').get('attributes') or []
        cached_personas = None
        try:
            sample_response = supabase.table("samples").select("persona").eq("id", sample_id).execute()
            if sample_response.data:
                cached_personas = sample_response.data[0].get('persona')
        except Exception as e:
            logger.warning(f"Could not read cached personas for sample {sample_id}: {e}")

        if personas_match(cached_personas, attributes, num_samples):
            random_samples = sorted(cached_personas, key=lambda x: x.get('number', 0))
        else:
            random_samples = generate_personas(attributes, num_samples)
            try:
                supabase.table("samples").update({"persona": random_samples}).eq("id", sample_id).execute()
            except Exception as e:
                logger.warning(f"Could not cache personas for sample {sample_id}: {e}")

        # Update progress to 10% - Setup complete, starting baseline
        supabase.table("experiments").update({"progress": 10}).eq("experiment_id", uuid).execute()

        # Generate baseline prompt and get token usage (progress 10-30% via callback)
        sample = data.get('sample')
        # Add the generated personas to the sample object
        sample['persona'] = random_samples

        on_baseline_row = create_progress_updater(
            uuid, supabase, 10, 30, num_samples,
            get_client=get_supabase_client, jwt=jwt, no_throttle=True
        )
        df, prompt_tokens, scale_answers = baseline_prompt(
            data, model_name, sample, progress_callback=on_baseline_row,
            parents=step_parents, children=step_children
        )

        # Evaluate responses and get token usage (progress 30-80% via per-column callback, write every call)
        steps = data.get('steps', [])
        num_cols_per_row = max(1, df.shape[1] - 1)
        total_eval_units = df.shape[0] * num_cols_per_row
        on_eval_unit = create_progress_updater(
            uuid, supabase, 30, 80, total_eval_units,
            get_client=get_supabase_client, jwt=jwt, no_throttle=True
        )
        summary_spec = {
            'title': data.get('title', ''),
            'run_date': datetime.now().strftime('%Y-%m-%d %H:%M'),
            'model': model_name,
            'num_personas': num_samples,
            'sample_name': sample.get('name', ''),
            'study_introduction': data.get('study_introduction', ''),
            'attributes': attributes,
        }
        fn, eval_tokens = evaluate(
            df, model_name, steps, progress_callback=on_eval_unit,
            scale_answers=scale_answers, summary_spec=summary_spec
        )

        df = df.replace('\n', '', regex=True)
        # sim_matrix = create_sim_matrix(df)
        
        # Progress already at 80% from callback; post-process is fast
        
        # Calculate total token usage for prompts
        total_prompt_input_token = sum(token_dict.get('prompt_tokens', 0) for token_dict in (prompt_tokens or []))
        total_prompt_output_token = sum(token_dict.get('response_tokens', 0) for token_dict in (prompt_tokens or []))
        total_prompt_total_token = sum(token_dict.get('total_tokens', 0) for token_dict in (prompt_tokens or []))

        # Calculate total token usage for evaluation
        total_eval_input_token = sum(token_dict.get('gemini_prompt_tokens', 0) for token_dict in (eval_tokens or []))
        total_eval_output_token = sum(token_dict.get('gemini_response_tokens', 0) for token_dict in (eval_tokens or []))
        total_eval_total_token = sum(token_dict.get('gemini_total_tokens', 0) for token_dict in (eval_tokens or []))

        # Store token usage and cost in Supabase
        total_tokens = total_prompt_total_token + total_eval_total_token
        prompt_cost, eval_cost = compute_prompt_and_eval_cost(
            total_prompt_input_token,
            total_prompt_output_token,
            total_eval_input_token,
            total_eval_output_token,
            model_name=model_name,
        )
        total_cost = prompt_cost + eval_cost
        supabase.table("tokens").insert({
            "id": uuid,
            "experiment_id": uuid,
            "operation": "simulation",
            "user_id": data.get("user_id"),
            "prompt_input_token": total_prompt_input_token,
            "prompt_output_token": total_prompt_output_token,
            "prompt_total_token": total_prompt_total_token,
            "eval_input_token": total_eval_input_token,
            "eval_output_token": total_eval_output_token,
            "eval_total_token": total_eval_total_token,
            "total_tokens": total_tokens,
            "prompt_cost": prompt_cost,
            "eval_cost": eval_cost,
            "total_cost": total_cost,
        }).execute()

        # Upload evaluation results to Supabase storage
        bucket_name = "llm-responses"
        with open(fn, 'rb') as f:
            upload_response = supabase.storage.from_(bucket_name).upload(
                path=f'llm/{fn}',
                file=f,
            )
        os.remove(fn)
        public_url = supabase.storage.from_(bucket_name).get_public_url(
            f'llm/{fn}')
        # sim_matrix['public_url'] = public_url

        # Update progress to 90% - File uploaded
        supabase.table("experiments").update({
            "progress": 90,
        }).eq("experiment_id", uuid).execute()

        response = supabase.table("experiments").update({
            "url": public_url,
        }).eq("experiment_id", uuid).execute()

        # Update progress to 100% - Completed
        supabase.table("experiments").update({
            "progress": 100,
            "status": "Completed"
        }).eq("experiment_id", uuid).execute()

        # Charge the user: token cost + flat run fee (free credits are used first).
        charge_amount = round(total_cost + RUN_FEE_USD, 6)
        if charge_and_record(data.get("user_id"), uuid, charge_amount) is None:
            logger.error("Run %s completed but charging user %s $%.6f failed",
                         uuid, data.get("user_id"), charge_amount)
    except Exception as e:
        logger.exception("Evaluation failed")
        # Create a new Supabase client for error handling
        supabase = get_supabase_client(jwt)
        supabase.table("experiments").update({
            "status": "Failed",
        }).eq("experiment_id", uuid).execute()
        # Clean up temporary file
        try:
            if fn and os.path.exists(fn):
                os.remove(fn)
        except:
            pass

class Evaluation(Resource):
    """
    Resource for handling LLM evaluation requests with progress tracking (now async via threading).
    """
    def post(self):
        try:
            auth_header = request.headers.get('Authorization')
            if not auth_header or not auth_header.startswith("Bearer "):
                logger.debug("No Authorization header or invalid format")
                jwt = None
            else:
                jwt = auth_header.split("Bearer ")[1]
            uuid = request.get_json()['id']
            data = request.get_json()['data']
            model_name = resolve_model_name(data.get('model', 'gemini-2.0-flash'))

            # Billing gate: the run is charged to the authenticated user, who
            # needs at least MIN_BALANCE_USD available after reserving the
            # expected cost of their other in-progress runs.
            user_id = get_verified_user_id(jwt)
            if not user_id:
                return {"status": "error", "error": "unauthorized", "message": "Please sign in to run a simulation."}, 401
            data = {**data, "user_id": user_id}
            balance = get_balance(user_id)
            if balance is None:
                return {"status": "error", "message": "Could not check your credit balance. Please try again."}, 503
            available = balance["total"] - reserved_for_running(user_id, exclude_experiment_id=uuid)
            if available < MIN_BALANCE_USD:
                return {
                    "status": "error",
                    "error": "insufficient_credits",
                    "message": (
                        f"You need at least {round(MIN_BALANCE_USD * CREDITS_PER_USD)} credits to run a simulation"
                        + (" (including runs still in progress)" if available < balance["total"] else "")
                        + f". You have {max(0, round(available * CREDITS_PER_USD))} available."
                    ),
                    "balance_credits": round(balance["total"] * CREDITS_PER_USD, 2),
                    "available_credits": round(available * CREDITS_PER_USD, 2),
                    "min_credits": round(MIN_BALANCE_USD * CREDITS_PER_USD),
                }, 402

            supabase: Client = create_client(url, key)
            if jwt:
                supabase.auth.set_session(jwt, "")
            # Create progress tracking entry.
            # If this ID already exists (e.g. a draft being run), delete the
            # old row first so the INSERT generates a fresh Realtime event that
            # Supabase can track for subsequent UPDATE broadcasts.
            task_id = uuid
            experiment_payload = {
                "experiment_id": uuid,
                "progress": 0,
                "status": "Started",
                "sample_name": data['sample']['name'],
                "user_id": data['user_id'],
                "simulation_name": data['title'],
                "experiment_data": data,
                "model": model_name,
            }
            existing = supabase.table("experiments").select("id, folder_id").eq("experiment_id", uuid).execute()
            if existing.data:
                # Preserve folder assignment from the draft
                folder_id = existing.data[0].get("folder_id")
                if folder_id:
                    experiment_payload["folder_id"] = folder_id
                supabase.table("experiments").delete().eq("experiment_id", uuid).execute()
            response = supabase.table("experiments").insert(
                experiment_payload
            ).execute()
            # Start background thread for evaluation, pass model_name and jwt
            thread = threading.Thread(target=run_evaluation, args=(uuid, data, model_name, jwt))
            thread.start()
            # Return immediately with task_id
            return jsonify({"status": "started", "task_id": task_id})
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)})


class Progress(Resource):
    """
    Resource for checking evaluation progress.
    """
    
    def get(self):
        """
        Handle GET requests for progress checking.
        
        Query parameters:
        - task_id: The task identifier
        - user_id: The user identifier
        
        Returns:
            JSON response containing progress information
        """
        try:
            auth_header = request.headers.get('Authorization')
            if not auth_header or not auth_header.startswith("Bearer "):
                jwt = None
            else:
                jwt = auth_header.split("Bearer ")[1]
            task_id = request.args.get('task_id')
            user_id = request.args.get('user_id')

            if not task_id or not user_id:
                return {"status": "error", "message": "Missing task_id or user_id"}, 400
            
            # Create a new Supabase client for this request
            supabase = get_supabase_client(jwt)
            response = supabase.table("experiments").select(
                "*").eq("experiment_id", task_id).execute()
            
            if response.data:
                progress_data = response.data[0]
                
                # Check if experiment is already completed - return early to avoid unnecessary processing
                status = progress_data.get('status', '').lower()
                progress = progress_data.get('progress', 0)
                
                # If completed or failed, log a warning if still being polled (this shouldn't happen)
                if status in ['completed', 'failed'] or (isinstance(progress, (int, float)) and progress >= 100):
                    logger.debug(f"Progress check for completed experiment {task_id} (status: {status}, progress: {progress})")
                
                return jsonify({
                    "status": "success",
                    "progress": progress_data
                })
            else:
                return {"status": "not_found", "message": "Progress not found"}, 404

        except Exception as e:
            logger.error(f"Error in Progress endpoint: {str(e)}")
            return {"status": "error", "message": str(e)}, 500


class GenerateSteps(Resource):
    """
    Resource for generating simulation steps from a user prompt using Gemini.
    """
    
    def post(self):
        """
        Handle POST requests for generating simulation steps.
        
        Request body:
        - prompt: The user's description of a cognitive task, behavior, or goal
        
        Returns:
            JSON response containing generated simulation steps in structured format
        """
        request_id = datetime.now().strftime('%Y%m%d%H%M%S%f')
        logger.info(f"[{request_id}] GenerateSteps POST request received")
        
        try:
            data = request.get_json()
            logger.debug(f"[{request_id}] Request data received: {json.dumps(data, indent=2)[:500]}")  # Log first 500 chars
            
            user_prompt = data.get('prompt')
            title = data.get('title', '')  # Optional: study title for context
            introduction = data.get('introduction', '')  # Optional: study introduction for context
            
            logger.info(f"[{request_id}] User prompt length: {len(user_prompt) if user_prompt else 0} characters")
            
            if not user_prompt:
                logger.warning(f"[{request_id}] Missing 'prompt' in request body")
                return {"status": "error", "message": "Missing 'prompt' in request body"}, 400
            
            # System prompt for the cognitive science researcher
            system_prompt = GENERATE_STEPS_SYSTEM_PROMPT

            # User prompt with title and introduction as context
            full_prompt = get_generate_steps_user_prompt(user_prompt, title=title, introduction=introduction)
            logger.debug(f"[{request_id}] Full prompt prepared (length: {len(full_prompt)} characters)")
            
            # Call LLM via LangChain
            logger.info(f"[{request_id}] Calling LLM ({DEFAULT_MODEL}) via LangChain")
            try:
                llm = get_llm(DEFAULT_MODEL, temperature=0.7)
                lc_response = llm.invoke([
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=full_prompt),
                ])
                # content may be a string or a list of parts depending on the provider/version
                raw_content = lc_response.content
                if isinstance(raw_content, list):
                    response_text = "".join(
                        part.get("text", "") if isinstance(part, dict) else str(part)
                        for part in raw_content
                    )
                else:
                    response_text = raw_content or ""
                logger.info(f"[{request_id}] LLM call successful")

                # Track token usage for generate_steps
                try:
                    usage_meta = extract_usage(lc_response)
                    prompt_count = usage_meta["input_tokens"]
                    output_count = usage_meta["output_tokens"]
                    total_count = usage_meta["total_tokens"]
                    auth_header = request.headers.get("Authorization")
                    jwt = auth_header.split("Bearer ")[1] if auth_header and auth_header.startswith("Bearer ") else None
                    supabase_client = get_supabase_client(jwt)
                    verified_user_id = get_verified_user_id(jwt)
                    user_id = verified_user_id or data.get("user_id")
                    if user_id is not None:
                        gen_prompt_cost = compute_cost(prompt_count, output_count, DEFAULT_MODEL)
                        token_row_id = str(uuid.uuid4())
                        supabase_client.table("tokens").insert({
                            "id": token_row_id,
                            "experiment_id": None,
                            "operation": "generate_steps",
                            "user_id": user_id,
                            "prompt_input_token": prompt_count,
                            "prompt_output_token": output_count,
                            "prompt_total_token": total_count,
                            "eval_input_token": 0,
                            "eval_output_token": 0,
                            "eval_total_token": 0,
                            "total_tokens": total_count,
                            "prompt_cost": gen_prompt_cost,
                            "eval_cost": 0.0,
                            "total_cost": gen_prompt_cost,
                        }).execute()
                        if verified_user_id:
                            charge_and_record(verified_user_id, token_row_id, gen_prompt_cost)
                except Exception as token_err:
                    logger.warning(f"[{request_id}] Failed to store token usage: {token_err}")
            except Exception as api_error:
                error_msg = str(api_error)
                error_type = type(api_error).__name__
                logger.error(f"[{request_id}] Error calling LLM: {error_type}: {error_msg}", exc_info=True)
                return {"status": "error", "message": f"Failed to call LLM: {error_msg}"}, 500

            # Parse JSON response
            logger.info(f"[{request_id}] Parsing LLM response")
            try:
                logger.info(f"[{request_id}] ========== FULL LLM RESPONSE ==========")
                logger.info(f"[{request_id}] Response text length: {len(response_text)} characters")
                logger.info(f"[{request_id}] Full response:\n{response_text}")
                logger.info(f"[{request_id}] ========================================")

                # Strip markdown code fences if the LLM wrapped the response
                cleaned = response_text.strip()
                if cleaned.startswith("```"):
                    cleaned = cleaned.split("```", 2)[1]  # drop opening fence
                    if cleaned.startswith("json"):
                        cleaned = cleaned[4:]
                    cleaned = cleaned.rsplit("```", 1)[0]  # drop closing fence
                steps_data = json.loads(cleaned.strip())
                logger.info(f"[{request_id}] JSON parsing successful")
                logger.info(f"[{request_id}] Parsed data structure:")
                logger.info(f"[{request_id}] {json.dumps(steps_data, indent=2)}")
                logger.debug(f"[{request_id}] Parsed data keys: {list(steps_data.keys())}")
            except (AttributeError, KeyError, IndexError) as parse_error:
                error_msg = str(parse_error)
                error_type = type(parse_error).__name__
                logger.error(f"[{request_id}] Error accessing LLM response: {error_type}: {error_msg}", exc_info=True)
                return {"status": "error", "message": f"Failed to access LLM response: {error_msg}"}, 500
            except json.JSONDecodeError as parse_error:
                error_msg = str(parse_error)
                logger.error(f"[{request_id}] JSON decode error: {error_msg}", exc_info=True)
                logger.error(f"[{request_id}] Response text that failed to parse: {response_text[:500]}")
                return {"status": "error", "message": f"Failed to parse JSON response from LLM: {error_msg}"}, 500

            # Validate basic structure - just needs to be a dict with at least one step
            logger.info(f"[{request_id}] Validating response structure")
            if not isinstance(steps_data, dict):
                logger.error(f"[{request_id}] Invalid response format: expected dict, got {type(steps_data)}")
                return {"status": "error", "message": "Invalid response format: expected a JSON object"}, 500
            
            # Extract introduction and title if present
            generated_introduction = steps_data.get('introduction', '')
            generated_title = (steps_data.get('title') or '').strip()
            if generated_introduction:
                logger.info(f"[{request_id}] Generated introduction found (length: {len(generated_introduction)} characters)")
            if generated_title:
                logger.info(f"[{request_id}] Generated title found: {generated_title}")
            
            # Validate and normalize step structure - check for "description" vs "instructions"
            step_keys = [k for k in steps_data.keys() if k.startswith('step')]
            if not step_keys:
                logger.error(f"[{request_id}] No steps found in response")
                logger.error(f"[{request_id}] Available keys: {list(steps_data.keys())}")
                return {"status": "error", "message": "Response must contain at least one step (step01, step02, etc.)"}, 500
            logger.info(f"[{request_id}] Found {len(step_keys)} step(s)")
            logger.debug(f"[{request_id}] Step keys: {step_keys}")
            
            # Normalize any steps that use "description" instead of "instructions"
            # Also filter out introduction steps
            introduction_keywords = ['introduction', 'welcome', 'overview', 'context', 'background', 'purpose']
            ordered_keys = sorted(step_keys)
            kept_keys = []
            dropped_keys = []

            for step_key in ordered_keys:
                step = steps_data[step_key]
                if not isinstance(step, dict):
                    continue
                # Normalize "description" to "instructions"
                if "description" in step and "instructions" not in step:
                    logger.warning(f"[{request_id}] Step {step_key} uses 'description' instead of 'instructions', normalizing...")
                    step["instructions"] = step.pop("description")
                elif "description" in step and "instructions" in step:
                    logger.warning(f"[{request_id}] Step {step_key} has both 'description' and 'instructions', removing 'description'")
                    step.pop("description")

                # Check if this is an introduction step and filter it out
                step_title = step.get('title', '').lower().strip()
                if any(keyword in step_title for keyword in introduction_keywords):
                    logger.warning(f"[{request_id}] Filtering out introduction step: {step_key} with title '{step.get('title', '')}'")
                    dropped_keys.append(step_key)
                    continue

                kept_keys.append(step_key)

            # Resolve each step's branches against the steps that survived. A
            # dropped step is spliced out rather than cutting the flow: whoever
            # pointed at it now points at whatever it pointed at.
            def resolve_next(step_key, seen=None):
                seen = seen or set()
                if step_key in seen:
                    return []
                seen.add(step_key)
                raw_next = steps_data.get(step_key, {}).get('next')
                if raw_next is None:
                    return []
                if not isinstance(raw_next, list):
                    raw_next = [raw_next]
                resolved = []
                for target in raw_next:
                    target = str(target).strip()
                    if target in kept_keys:
                        if target not in resolved:
                            resolved.append(target)
                    elif target in dropped_keys:
                        for spliced in resolve_next(target, seen):
                            if spliced not in resolved:
                                resolved.append(spliced)
                    else:
                        logger.warning(f"[{request_id}] Step {step_key} points at unknown step '{target}', dropping that branch")
                return resolved

            # Only treat this as a branching design if at least one step
            # actually points somewhere. A "next" that is present but empty
            # everywhere would otherwise leave every step disconnected.
            declared_branching = any(resolve_next(key) for key in kept_keys)

            # Renumber survivors, remapping the branch references as we go
            key_remap = {key: f"step{i + 1:02d}" for i, key in enumerate(kept_keys)}
            filtered_steps = {}
            for original_key in kept_keys:
                step = dict(steps_data[original_key])
                new_key = key_remap[original_key]
                if declared_branching:
                    step['next'] = [key_remap[t] for t in resolve_next(original_key)]
                    step['sample_proportion'] = _coerce_number(
                        step.get('sample_proportion'), 100
                    )
                else:
                    # No branching declared: keep the straight line the steps
                    # were generated in.
                    step.pop('next', None)
                    step.pop('sample_proportion', None)
                filtered_steps[new_key] = step

            if declared_branching and filtered_steps:
                filtered_steps = _validate_generated_branching(
                    filtered_steps, request_id
                )

            if not filtered_steps:
                logger.error(f"[{request_id}] All steps were filtered out as introduction steps")
                return {"status": "error", "message": "No valid steps generated. Please ensure your prompt describes actual tasks, not just an introduction."}, 500
            
            # Build output dict with steps, introduction, and optional title
            output_dict = filtered_steps.copy()
            if generated_introduction:
                output_dict['introduction'] = generated_introduction
            if generated_title:
                output_dict['title'] = generated_title
            
            logger.info(f"[{request_id}] Response validated and normalized successfully. {len(filtered_steps)} step(s) after filtering out introduction steps.")
            if generated_introduction:
                logger.info(f"[{request_id}] Generated introduction included in response")
            
            # Return the structured data (output_dict contains steps and optionally introduction)
            logger.info(f"[{request_id}] Returning successful response")
            return jsonify({
                "status": "success",
                "data": output_dict
            })
            
        except Exception as e:
            # Catch-all for any unexpected errors
            error_msg = str(e)
            error_type = type(e).__name__
            logger.error(f"[{request_id}] Unexpected error in GenerateSteps: {error_type}: {error_msg}", exc_info=True)
            import traceback
            logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
            return {"status": "error", "message": f"An unexpected error occurred: {error_msg}"}, 500


MAX_PDF_BYTES = 20 * 1024 * 1024  # 20 MB - Gemini inline data limit territory


def _validate_generated_branching(filtered_steps, request_id):
    """
    Check a generated branching design and fall back to a straight line if it
    does not hold up.

    The model can produce a graph that loops, has two starting points, or has
    proportions that don't add up. Rather than failing the request, hand back
    the same steps in a straight line - the researcher gets a usable design on
    the canvas and can add the branches themselves.
    """
    ordered_keys = list(filtered_steps.keys())
    graph_steps = [
        {
            'id': key,
            'label': filtered_steps[key].get('title', key),
            'next': filtered_steps[key].get('next', []),
            'sample_proportion': filtered_steps[key].get('sample_proportion', 100),
        }
        for key in ordered_keys
    ]

    normalized, parents, children = normalize_graph(graph_steps)
    errors = validate_graph(normalized, parents, children)

    if not errors:
        return filtered_steps

    logger.warning(
        f"[{request_id}] Generated branching design was invalid, falling back to a "
        f"linear flow. Problems: {' '.join(errors)}"
    )
    for key in ordered_keys:
        filtered_steps[key].pop('next', None)
        filtered_steps[key].pop('sample_proportion', None)
    return filtered_steps


def _coerce_number(value, fallback):
    """Coerce an LLM-supplied value to a number, falling back when unusable."""
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        match = re.search(r'-?\d+(\.\d+)?', value)
        if match:
            text = match.group(0)
            return float(text) if '.' in text else int(text)
    return fallback


def normalize_parsed_studies(raw_studies):
    """
    Validate and normalize the studies array returned by the LLM.

    Guarantees every study has a title, a sample, well-formed measures with
    unique ids and numeric bounds, and steps whose measure_ids only reference
    measures that exist in the same study. Studies without any usable step are
    dropped, since they cannot become a runnable simulation.
    """
    normalized = []

    for study_index, study in enumerate(raw_studies or []):
        if not isinstance(study, dict):
            continue

        title = (study.get("title") or "").strip() or f"Study {study_index + 1}"

        # --- measures -------------------------------------------------------
        measures = []
        measure_ids = set()
        for measure_index, measure in enumerate(study.get("measures") or []):
            if not isinstance(measure, dict):
                continue
            measure_title = (measure.get("title") or "").strip()
            if not measure_title:
                continue

            measure_id = (measure.get("id") or "").strip() or f"m{measure_index + 1}"
            while measure_id in measure_ids:
                measure_id = f"{measure_id}x"
            measure_ids.add(measure_id)

            min_value = _coerce_number(measure.get("min_value"), 1)
            max_value = _coerce_number(measure.get("max_value"), 7)
            if max_value <= min_value:
                max_value = min_value + 1

            anchors = []
            for anchor in measure.get("value_anchors") or []:
                if not isinstance(anchor, dict):
                    continue
                label = (anchor.get("label") or "").strip()
                if not label:
                    continue
                value = _coerce_number(anchor.get("value"), min_value)
                value = max(min_value, min(max_value, value))
                anchors.append({"value": value, "label": label})

            if not anchors:
                anchors = [
                    {"value": min_value, "label": "Lowest"},
                    {"value": max_value, "label": "Highest"},
                ]

            measures.append({
                "id": measure_id,
                "title": measure_title,
                "definition": (measure.get("definition") or "").strip(),
                "min_value": min_value,
                "max_value": max_value,
                "value_anchors": anchors,
            })

        # --- steps ----------------------------------------------------------
        steps = []
        for step_index, step in enumerate(study.get("steps") or []):
            if not isinstance(step, dict):
                continue
            label = (step.get("label") or step.get("title") or "").strip()
            instruction = (step.get("instruction") or step.get("instructions") or "").strip()
            if not label and not instruction:
                continue

            referenced = [
                str(measure_id)
                for measure_id in (step.get("measure_ids") or [])
                if str(measure_id) in measure_ids
            ]

            steps.append({
                "id": (step.get("id") or "").strip() or f"s{step_index + 1}",
                "label": label or f"Step {step_index + 1}",
                "instruction": instruction,
                "measure_ids": referenced,
            })

        steps = steps[:10]  # keep parity with the 10-step cap used elsewhere

        if not steps:
            logger.warning(f"Dropping parsed study '{title}' - no usable steps")
            continue

        # --- sample ---------------------------------------------------------
        raw_sample = study.get("sample") if isinstance(study.get("sample"), dict) else {}
        attributes = []
        for attribute in raw_sample.get("attributes") or []:
            if not isinstance(attribute, dict):
                continue
            name = (attribute.get("name") or "").strip()
            value = attribute.get("value")
            if isinstance(value, list):
                value = ", ".join(str(item) for item in value)
            value = (str(value) if value is not None else "").strip()
            if name and value:
                attributes.append({"name": name, "value": value})

        normalized.append({
            "title": title,
            "brief_description": (study.get("brief_description") or "").strip(),
            "study_introduction": (study.get("study_introduction") or "").strip(),
            "sample": {
                "name": (raw_sample.get("name") or "").strip() or f"{title} Sample",
                "attributes": attributes,
            },
            "measures": measures,
            "steps": steps,
        })

    return normalized


class ParsePDF(Resource):
    """
    Resource for extracting research studies from an uploaded PDF using Gemini.

    The PDF is passed to the model as inline data (no server-side text
    extraction), so figures, tables, and multi-column layouts stay intact.
    """

    def post(self):
        """
        Handle POST requests for parsing a research PDF.

        Request (multipart/form-data):
        - file: The PDF file to parse
        - user_id: Optional user id used for token accounting

        Returns:
            JSON response containing the document title and the studies found
        """
        request_id = datetime.now().strftime('%Y%m%d%H%M%S%f')
        logger.info(f"[{request_id}] ParsePDF POST request received")

        try:
            uploaded = request.files.get('file')
            if uploaded is None:
                logger.warning(f"[{request_id}] Missing 'file' in request")
                return {"status": "error", "message": "Missing 'file' in request"}, 400

            filename = uploaded.filename or "document.pdf"
            file_bytes = uploaded.read()

            if not file_bytes:
                logger.warning(f"[{request_id}] Uploaded file is empty")
                return {"status": "error", "message": "The uploaded file is empty"}, 400

            if len(file_bytes) > MAX_PDF_BYTES:
                logger.warning(f"[{request_id}] Uploaded file too large: {len(file_bytes)} bytes")
                return {
                    "status": "error",
                    "message": f"PDF is too large. Maximum size is {MAX_PDF_BYTES // (1024 * 1024)} MB.",
                }, 413

            if not file_bytes.startswith(b'%PDF'):
                logger.warning(f"[{request_id}] Uploaded file is not a PDF")
                return {"status": "error", "message": "The uploaded file is not a valid PDF"}, 400

            logger.info(f"[{request_id}] Parsing '{filename}' ({len(file_bytes)} bytes)")

            encoded_pdf = base64.b64encode(file_bytes).decode('utf-8')

            # Call LLM via LangChain, passing the PDF as inline media
            logger.info(f"[{request_id}] Calling LLM ({DEFAULT_MODEL}) via LangChain")
            try:
                llm = get_llm(DEFAULT_MODEL, temperature=0.2)
                lc_response = llm.invoke([
                    SystemMessage(content=PARSE_PDF_SYSTEM_PROMPT),
                    HumanMessage(content=[
                        {"type": "text", "text": get_parse_pdf_user_prompt(filename)},
                        {
                            "type": "media",
                            "mime_type": "application/pdf",
                            "data": encoded_pdf,
                        },
                    ]),
                ])
                raw_content = lc_response.content
                if isinstance(raw_content, list):
                    response_text = "".join(
                        part.get("text", "") if isinstance(part, dict) else str(part)
                        for part in raw_content
                    )
                else:
                    response_text = raw_content or ""
                logger.info(f"[{request_id}] LLM call successful")

                # Track token usage for parse_pdf
                try:
                    usage_meta = extract_usage(lc_response)
                    prompt_count = usage_meta["input_tokens"]
                    output_count = usage_meta["output_tokens"]
                    total_count = usage_meta["total_tokens"]
                    auth_header = request.headers.get("Authorization")
                    jwt = auth_header.split("Bearer ")[1] if auth_header and auth_header.startswith("Bearer ") else None
                    supabase_client = get_supabase_client(jwt)
                    verified_user_id = get_verified_user_id(jwt)
                    user_id = verified_user_id or request.form.get("user_id")
                    if user_id is not None:
                        parse_prompt_cost = compute_cost(prompt_count, output_count, DEFAULT_MODEL)
                        token_row_id = str(uuid.uuid4())
                        supabase_client.table("tokens").insert({
                            "id": token_row_id,
                            "experiment_id": None,
                            "operation": "parse_pdf",
                            "user_id": user_id,
                            "prompt_input_token": prompt_count,
                            "prompt_output_token": output_count,
                            "prompt_total_token": total_count,
                            "eval_input_token": 0,
                            "eval_output_token": 0,
                            "eval_total_token": 0,
                            "total_tokens": total_count,
                            "prompt_cost": parse_prompt_cost,
                            "eval_cost": 0.0,
                            "total_cost": parse_prompt_cost,
                        }).execute()
                        if verified_user_id:
                            charge_and_record(verified_user_id, token_row_id, parse_prompt_cost)
                except Exception as token_err:
                    logger.warning(f"[{request_id}] Failed to store token usage: {token_err}")
            except Exception as api_error:
                error_msg = str(api_error)
                error_type = type(api_error).__name__
                logger.error(f"[{request_id}] Error calling LLM: {error_type}: {error_msg}", exc_info=True)
                return {"status": "error", "message": f"Failed to call LLM: {error_msg}"}, 500

            # Parse JSON response
            try:
                cleaned = response_text.strip()
                if cleaned.startswith("```"):
                    cleaned = cleaned.split("```", 2)[1]  # drop opening fence
                    if cleaned.startswith("json"):
                        cleaned = cleaned[4:]
                    cleaned = cleaned.rsplit("```", 1)[0]  # drop closing fence
                parsed_data = json.loads(cleaned.strip())
            except json.JSONDecodeError as parse_error:
                logger.error(f"[{request_id}] JSON decode error: {parse_error}", exc_info=True)
                logger.error(f"[{request_id}] Response text that failed to parse: {response_text[:500]}")
                return {
                    "status": "error",
                    "message": "The document could not be parsed into studies. Please try a different PDF.",
                }, 500

            if not isinstance(parsed_data, dict):
                logger.error(f"[{request_id}] Invalid response format: expected dict, got {type(parsed_data)}")
                return {"status": "error", "message": "Invalid response format: expected a JSON object"}, 500

            studies = normalize_parsed_studies(parsed_data.get("studies"))
            document_title = (parsed_data.get("document_title") or "").strip()

            logger.info(f"[{request_id}] Parsed {len(studies)} study/studies from '{filename}'")

            return jsonify({
                "status": "success",
                "data": {
                    "document_title": document_title,
                    "studies": studies,
                },
            })

        except Exception as e:
            error_msg = str(e)
            error_type = type(e).__name__
            logger.error(f"[{request_id}] Unexpected error in ParsePDF: {error_type}: {error_msg}", exc_info=True)
            import traceback
            logger.error(f"[{request_id}] Traceback: {traceback.format_exc()}")
            return {"status": "error", "message": f"An unexpected error occurred: {error_msg}"}, 500


class Checkout(Resource):
    """
    Create a Stripe Checkout Session for purchasing simulation credits.

    Accepts an arbitrary dollar amount and builds the line item server-side with
    inline price_data, so custom amounts work without pre-creating Prices in the
    Stripe Dashboard. The secret key never leaves the backend.
    """

    def post(self):
        try:
            if not stripe.api_key:
                return {"status": "error", "message": "Stripe is not configured (missing STRIPE_SECRET_KEY)."}, 500

            data = request.get_json(silent=True) or {}

            try:
                amount = float(data.get("amount"))
            except (TypeError, ValueError):
                return {"status": "error", "message": "Invalid amount."}, 400

            if not (STRIPE_MIN_AMOUNT <= amount <= STRIPE_MAX_AMOUNT):
                return {
                    "status": "error",
                    "message": f"Amount must be between ${STRIPE_MIN_AMOUNT} and ${STRIPE_MAX_AMOUNT}.",
                }, 400

            # Stripe expects the amount in cents.
            unit_amount = round(amount * 100)

            user_id = data.get("userId")
            email = data.get("email")
            # The frontend passes its own origin so success/cancel return to the
            # right place; fall back to the request Origin header.
            origin = data.get("origin") or request.headers.get("Origin") or "http://localhost:3000"

            session = stripe.checkout.Session.create(
                mode="payment",
                line_items=[{
                    "quantity": 1,
                    "price_data": {
                        "currency": STRIPE_CURRENCY,
                        "unit_amount": unit_amount,
                        "product_data": {"name": "Simulation credits"},
                    },
                }],
                # session_id is needed on return so we can verify the payment
                # before crediting (don't trust a raw amount in the URL).
                success_url=f"{origin}/account?status=success&session_id={{CHECKOUT_SESSION_ID}}",
                cancel_url=f"{origin}/account?status=cancel",
                customer_email=email,
                client_reference_id=user_id,
                metadata={"userId": user_id or "", "credits": str(amount)},
            )

            return jsonify({"url": session.url})
        except Exception as e:
            logger.exception("Stripe checkout failed")
            return {"status": "error", "message": str(e)}, 502


class CheckoutVerify(Resource):
    """
    Verify a completed Stripe Checkout Session on return from Stripe. The client
    calls this with the session_id from the success URL; we confirm the payment
    is actually paid and report the real amount so the balance is credited from a
    trusted source rather than a spoofable query param.
    """

    def get(self):
        try:
            if not stripe.api_key:
                return {"status": "error", "message": "Stripe is not configured (missing STRIPE_SECRET_KEY)."}, 500

            session_id = request.args.get("session_id")
            if not session_id:
                return {"status": "error", "message": "Missing session_id."}, 400

            session = stripe.checkout.Session.retrieve(session_id)
            # StripeObject overrides attribute access, so dict.get() is not
            # available — use attribute access (these fields are always present,
            # possibly None).
            paid = session.payment_status == "paid"
            amount_total = session.amount_total  # in cents
            amount = (amount_total / 100) if (paid and amount_total is not None) else 0
            user_id = session.client_reference_id

            # Credit the user's account in Supabase from this trusted context.
            balance = None
            if paid and user_id and amount > 0:
                balance = credit_user_account(user_id, amount, session)

            return jsonify({
                "paid": paid,
                "amount": amount,
                "userId": user_id,
                "balance": balance,
            })
        except Exception as e:
            logger.exception("Stripe verify failed")
            return {"status": "error", "message": str(e)}, 502


class Credits(Resource):
    """
    Return the authenticated user's balance (USD) plus the pricing parameters
    the frontend needs to show credits, estimates and "free runs left".
    """

    def get(self):
        user_id = get_verified_user_id(jwt_from_request())
        if not user_id:
            return {"status": "error", "message": "Unauthorized"}, 401
        balance = get_balance(user_id)
        if balance is None:
            return {"status": "error", "message": "Could not read balance."}, 503
        reserved = reserved_for_running(user_id)
        return {
            "free_usd": round(balance["free"], 6),
            "paid_usd": round(balance["paid"], 6),
            "total_usd": round(balance["total"], 6),
            "reserved_usd": round(reserved, 6),
            "available_usd": round(balance["total"] - reserved, 6),
            **pricing_params(),
        }


# Register the resources with the API
api.add_resource(Evaluation, "/evaluate")
api.add_resource(Progress, "/progress")
api.add_resource(GenerateSteps, "/generate-steps")
api.add_resource(ParsePDF, "/parse-pdf")
api.add_resource(Checkout, "/checkout")
api.add_resource(CheckoutVerify, "/checkout/verify")
api.add_resource(Credits, "/credits")

# Register the API blueprint with the Flask application
app.register_blueprint(api_bp, url_prefix="/api")

if __name__ == "__main__":
    # Configure and run the Flask application based on environment
    prod = os.environ.get("DEV") or 'production'
    if prod == 'development':
        app.run(debug=True, use_reloader=False)
    else:
        app.run(debug=True, host="0.0.0.0", port=int(
            os.environ.get("PORT", 8080)))
