#!/bin/bash

set -e

# Configuration
SERVICE_NAME="cgov-api"
REGION="europe-west1"
ENV_FILE=".env"

# Check if .env exists
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found"
  exit 1
fi

# Get default project
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)

if [ -z "$PROJECT_ID" ]; then
  echo "Error: No default GCP project set"
  echo "Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "Loading environment variables from .env..."

# Parse .env and build env vars string
ENV_VARS=""
while IFS='=' read -r key value; do
  # Skip comments and empty lines
  [[ "$key" =~ ^#.*$ ]] && continue
  [[ -z "$key" ]] && continue

  # Clean key and value
  key=$(echo "$key" | xargs)
  value=$(echo "$value" | xargs | sed 's/^["'\'']//' | sed 's/["'\'']$//')

  # Skip empty values
  [[ -z "$value" ]] && continue

  # Add to env vars string
  if [ -z "$ENV_VARS" ]; then
    ENV_VARS="$key=$value"
  else
    ENV_VARS="$ENV_VARS,$key=$value"
  fi

  echo "   $key"
done < "$ENV_FILE"

echo ""
echo "Deploying to Cloud Run..."
echo "  Project: $PROJECT_ID"
echo "  Service: $SERVICE_NAME"
echo "  Region:  $REGION"
echo ""

# Deploy
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "$ENV_VARS" \
  --quiet

echo ""
echo "Deployment complete!"
echo ""

# Show service URL
gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --format 'value(status.url)'
