FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY monitor.py .

VOLUME ["/data"]
ENV DB_PATH=/data/referrals.db

CMD ["python", "monitor.py"]
