ARG BASE_IMAGE=mb-pm:knowledge-mbweb-20261002T155133Z
FROM ${BASE_IMAGE}
WORKDIR /gateway
COPY app.py bootstrap.js /gateway/
USER 10001:10001
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--no-proxy-headers"]
