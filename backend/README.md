# Cognition Simulation Backend

A Flask-based backend service for LLM evaluation and response analysis, deployed on Google Cloud Run.

## Overview

This service provides an API endpoint for evaluating LLM responses using various metrics and storing results in Supabase. It integrates with Google's Gemini API for LLM operations and handles CORS for both development and production environments.

## Features

- LLM response evaluation and analysis
- Integration with Google Gemini API
- Supabase database integration
- Token usage and cost tracking (prompt_cost, eval_cost, total_cost via Cloud Billing Catalog API or fallback rates)
- CORS support for development and production
- Secure authentication in production

## API Endpoints

- `POST /api/evaluate`: Evaluates LLM responses and returns similarity matrices
  - Requires authentication in production
  - Returns evaluation results and token usage statistics

## Environment Variables

Required environment variables:

- `VITE_SUPABASE_URL`: Supabase project URL
- `VITE_SUPABASE_KEY`: Supabase API key
- `VITE_SUPABASE_BUCKET_URL` Supabase Bucket URL
- `GEMINI_KEY`: Google Gemini API key
- `VITE_GCP_TOKEN`: Authentication token for production
- `DEV`: Set to 'development' for local development
- `OPENAI_API_KEY` OpenAI API key
- `SUPABASE_SERVICE_ROLE_KEY`: Required for billing (reading balances, charging runs, crediting Stripe purchases).

Token pricing is a static table in `utils/pricing.py` (Gemini Developer API rates; gemini-2.5-flash: $0.30/1M input, $2.50/1M output incl. thinking). Update it when Google changes prices or a new model is added.

## Database Migration

Credits/billing need `supabase/migrations/20261108000000_credits.sql` (repo root). Run it in the Supabase SQL Editor or with `supabase db push`. It:

- adds `user_emails.free_credits` and grants $5 (500 credits) once to every existing and new user
- blocks clients from writing their own balance (trigger)
- adds `charge_user` / `add_paid_credits` RPCs (service role only) and `tokens.charged_amount` / `tokens.free_portion`

## Development

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Run locally:
   ```bash
   python app.py
   ```

## Deployment

The application is containerized using Docker and deployed to Google Cloud Run. The Dockerfile is configured to:
- Use Python 3.11
- Install dependencies from requirements.txt
- Expose port 8080
- Run with Gunicorn (4-minute timeout)

## Dependencies

Key dependencies include:
- Flask 3.0.3
- Flask-RESTful 0.3.10
- Google Generative AI 0.8.3
- Supabase 2.10.0
- Various ML libraries (torch, transformers, scikit-learn)
