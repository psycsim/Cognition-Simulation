-- Credits: free-credit grant, protected balance columns, atomic charge/credit RPCs.
--
-- Units: user_emails.credits and user_emails.free_credits are stored in USD.
-- The app displays them as credits ($1 = 100 credits, see backend/utils/pricing.py).
--
-- Safe to re-run: columns use IF NOT EXISTS, the backfill only touches rows that
-- haven't received the grant, and functions/triggers are CREATE OR REPLACE.

-- 1. Free-credit columns --------------------------------------------------------
-- Added with "not yet granted" defaults so the backfill below can find every
-- existing row; the defaults are switched afterwards so new signups get $5.
alter table public.user_emails
  add column if not exists free_credits numeric not null default 0,
  add column if not exists free_grant_applied boolean not null default false;

-- 2. One-time $5 grant for existing users (idempotent) --------------------------
update public.user_emails
   set free_credits = free_credits + 5,
       free_grant_applied = true
 where free_grant_applied = false;

-- 3. New rows get the grant via column defaults ---------------------------------
alter table public.user_emails
  alter column free_credits set default 5,
  alter column free_grant_applied set default true;

update public.user_emails set credits = 0 where credits is null;
alter table public.user_emails alter column credits set default 0;

-- 4. Record what each operation actually deducted -------------------------------
alter table public.tokens
  add column if not exists charged_amount numeric,
  add column if not exists free_portion numeric;

-- 5. Stop clients from writing their own balance --------------------------------
-- The browser upserts user_emails with the anon key on every login. Without
-- this trigger a user could set credits/free_credits to anything. Only the
-- service role (backend) and SECURITY DEFINER functions may change them.
create or replace function public.protect_user_balance()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.credits := 0;
      new.free_credits := 5;
      new.free_grant_applied := true;
    else
      new.credits := old.credits;
      new.free_credits := old.free_credits;
      new.free_grant_applied := old.free_grant_applied;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_user_balance on public.user_emails;
create trigger protect_user_balance
  before insert or update on public.user_emails
  for each row execute function public.protect_user_balance();

-- 6. Atomic charge: spend free credits first, then paid --------------------------
-- Paid credits may go slightly negative (the run is charged its actual cost
-- after it finishes; the backend requires >= $1 available before starting).
create or replace function public.charge_user(p_user_id uuid, p_amount numeric)
returns table (free_portion numeric, paid_portion numeric, free_left numeric, paid_left numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_free numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'charge amount must be positive';
  end if;

  select ue.uuid as row_id,
         coalesce(ue.free_credits, 0) as free_bal,
         coalesce(ue.credits, 0) as paid_bal
    into r
    from public.user_emails ue
   where ue.user_id = p_user_id
   order by ue.created_at
   limit 1
   for update;

  if not found then
    return;
  end if;

  v_free := least(greatest(r.free_bal, 0), p_amount);

  update public.user_emails ue
     set free_credits = r.free_bal - v_free,
         credits = r.paid_bal - (p_amount - v_free)
   where ue.uuid = r.row_id;

  return query select v_free, p_amount - v_free, r.free_bal - v_free, r.paid_bal - (p_amount - v_free);
end;
$$;

-- 7. Atomic purchase credit (replaces read-modify-write in the backend) -----------
create or replace function public.add_paid_credits(p_user_id uuid, p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'credit amount must be positive';
  end if;

  update public.user_emails ue
     set credits = coalesce(ue.credits, 0) + p_amount
   where ue.uuid = (
     select x.uuid from public.user_emails x
      where x.user_id = p_user_id
      order by x.created_at
      limit 1
   )
  returning ue.credits into v_balance;

  return v_balance;
end;
$$;

-- Only the backend (service role) may call the money-moving functions.
revoke all on function public.charge_user(uuid, numeric) from public, anon, authenticated;
revoke all on function public.add_paid_credits(uuid, numeric) from public, anon, authenticated;
grant execute on function public.charge_user(uuid, numeric) to service_role;
grant execute on function public.add_paid_credits(uuid, numeric) to service_role;
