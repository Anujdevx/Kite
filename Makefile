.PHONY: up down logs test

up:
	@test -f .env || (echo "Missing .env: run 'cp .env.example .env' and add your keys" && exit 1)
	docker compose up --build -d
	@echo "frontend: http://localhost:3000  backend: http://localhost:8000/health"

down:
	docker compose down

logs:
	docker compose logs -f

test:
	cd backend && python -m pytest -q
