-- Risicoprofielen: voeg `profile` kolom toe + reset bestaande data (Joep wil schone start).
-- 4 profielen draaien parallel: laag, gemiddeld, hoog, extreem.

-- 1. Add profile column
alter table bot_trades         add column if not exists profile text not null default 'gemiddeld';
alter table bot_signals        add column if not exists profile text not null default 'gemiddeld';
alter table bot_portfolio      add column if not exists profile text not null default 'gemiddeld';
alter table bot_open_positions add column if not exists profile text not null default 'gemiddeld';

-- 2. Indexen voor filteren op profile (dashboard query's)
create index if not exists bot_trades_profile_idx     on bot_trades (profile, closed_at desc);
create index if not exists bot_signals_profile_idx    on bot_signals (profile, created_at desc);
create index if not exists bot_portfolio_profile_idx  on bot_portfolio (profile, snapshot_at desc);
create index if not exists bot_open_positions_profile_idx on bot_open_positions (profile);

-- 3. Unique constraint op bot_open_positions: (pair, profile) ipv alleen (pair)
--    zodat verschillende profielen tegelijk dezelfde pair open kunnen hebben.
alter table bot_open_positions drop constraint if exists bot_open_positions_pair_key;
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'bot_open_positions_pair_profile_key'
    ) then
        alter table bot_open_positions add constraint bot_open_positions_pair_profile_key unique (pair, profile);
    end if;
end $$;

-- 4. Reset: schone start zoals afgesproken (alle 4 profielen vanaf EUR 1000)
truncate table bot_trades;
truncate table bot_signals;
truncate table bot_portfolio;
truncate table bot_open_positions;
