@echo off
title Pickleball Server
start "" "http://localhost:8000"
python -m http.server 8000
