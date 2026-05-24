-- Persistente tracking van open posities zodat bot herstart-bestendig is
-- en het dashboard live floating PnL kan tonen.

create table if not exists bot_open_positions (
    id              bigserial primary key,
    pair            text        not null unique,    -- max 1 open positie per pair
    entry_price     numeric     not null,
    size            numeric     not null,
    stop_loss_price numeric     not null,
    opened_at       timestamptz not null default now()
);

create index if not exists bot_open_positions_pair_idx on bot_open_positions (pair);

alter table bot_open_positions enable row level security;
drop policy if exists "bot_open_positions_anon_read" on bot_open_positions;
create policy "bot_open_positions_anon_read" on bot_open_positions for select to anon using (true);
