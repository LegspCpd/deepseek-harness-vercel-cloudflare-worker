# Hugging Face Space (Docker) image for the DeepSeek Harness sandbox.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    SANDBOX_WORKSPACE=/workspace \
    SANDBOX_SECRET="" \
    SANDBOX_TIMEOUT_S=60 \
    SANDBOX_MAX_OUTPUT_BYTES=100000

WORKDIR /app

# Python tooling the agent commonly needs inside the sandbox.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash git curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# HF Spaces in Docker mode serve on port 7860.
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
