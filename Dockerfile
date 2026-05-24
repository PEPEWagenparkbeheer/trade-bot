# Fly.io container voor de trade-bot loop.
# Draait alleen `python -m engine.bot` (geen FastAPI — dashboard staat al op Vercel).

FROM python:3.12-slim

WORKDIR /app

# Systeembibliotheken die pandas/numpy nodig hebben
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

# Python deps eerst (cache laag) — anthropic + fastapi niet nodig in bot-only container
COPY requirements.txt .
RUN pip install --no-cache-dir \
      ccxt pandas numpy python-dotenv supabase pydantic httpx

# Applicatie code
COPY config.py ./
COPY api ./api
COPY data ./data
COPY engine ./engine
COPY portfolio ./portfolio
COPY strategy ./strategy

# Bot draait altijd door (interval via env), produceert geen logs naar disk in container
ENV PYTHONUNBUFFERED=1
ENV INTERVAL=60

CMD ["python", "-m", "engine.bot", "--interval", "60"]
