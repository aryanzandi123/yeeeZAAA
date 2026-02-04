#!/usr/bin/env bash
# Exit on error
set -o errexit

echo "Upgrading pip..."
pip install --upgrade pip

echo "Installing dependencies with increased timeout..."
pip install -r requirements.txt --default-timeout=100
