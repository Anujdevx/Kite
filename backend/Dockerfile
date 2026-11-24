# ---- build stage: install deps into a venv ----
FROM python:3.13-slim AS build
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---- runtime stage: venv + app code only, non-root ----
FROM python:3.13-slim
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 DATABASE_URL=sqlite:////data/app.db
RUN useradd --create-home app && mkdir /data && chown app /data
COPY --from=build /opt/venv /opt/venv
WORKDIR /srv
COPY app ./app
USER app
VOLUME /data
EXPOSE 8000
# PORT is set by hosts like Render; 8000 locally
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
