# Stack Detection Patterns

How to identify a project's stack by scanning its files.

## Detection Order

Scan for these files at the project root. A project may match multiple patterns.

## JavaScript / TypeScript

| File | Indicates |
|------|-----------|
| `package.json` | Node.js project |
| `bun.lockb`, `bunfig.toml` | Bun runtime |
| `pnpm-lock.yaml` | pnpm package manager |
| `yarn.lock` | Yarn package manager |
| `next.config.*` | Next.js (preview: 3000) |
| `vite.config.*` | Vite (preview: 5173) |
| `angular.json` | Angular (preview: 4200) |
| `nuxt.config.*` | Nuxt (preview: 3000) |
| `svelte.config.*` | SvelteKit (preview: 5173) |
| `remix.config.*`, `app/root.tsx` | Remix (preview: 3000) |
| `astro.config.*` | Astro (preview: 4321) |
| `playwright.config.*` | Playwright tests — add to build.sh: `npx playwright install --with-deps chromium` |
| `cypress.config.*`, `cypress/` | Cypress tests — add to build.sh: cypress deps |

### Package.json Scripts

Check `scripts` for:
- `dev`, `start`, `serve` — dev server command (use in setup)
- `test`, `test:unit`, `test:e2e` — test command
- `build` — build command (may reveal framework)

## PHP

| File | Indicates |
|------|-----------|
| `composer.json` | PHP + Composer |
| `wp-env.json`, `.wp-env.json` | WordPress wp-env (preview: 8888) |
| `artisan` | Laravel (preview: 8000) |
| `symfony.lock` | Symfony (preview: 8000) |

### Build.sh additions
- PHP runtime + extensions (check composer.json `require.php` for version)
- Composer
- MariaDB/MySQL client if database used

## Python

| File | Indicates |
|------|-----------|
| `requirements.txt`, `setup.py`, `pyproject.toml` | Python project |
| `Pipfile` | Pipenv |
| `poetry.lock` | Poetry |
| `manage.py` | Django (preview: 8000) |
| `app.py` + flask in deps | Flask (preview: 5000) |
| `main.py` + fastapi in deps | FastAPI (preview: 8000) |

### Build.sh additions
- Python version (check `.python-version`, `pyproject.toml`, `runtime.txt`)
- pip/pipenv/poetry
- System packages for compiled deps (libpq-dev, libffi-dev, etc.)

## Ruby

| File | Indicates |
|------|-----------|
| `Gemfile` | Ruby project |
| `config/routes.rb`, `bin/rails` | Rails (preview: 3000) |

### Build.sh additions
- Ruby version (check `.ruby-version`, `Gemfile`)
- Bundler
- libpq-dev if using PostgreSQL, default-libmysqlclient-dev if MySQL

## Go

| File | Indicates |
|------|-----------|
| `go.mod` | Go project |
| `go.sum` | Go dependencies |

### Build.sh additions
- Go runtime (check `go.mod` for version)

## Rust

| File | Indicates |
|------|-----------|
| `Cargo.toml` | Rust project |

### Build.sh additions
- Rust toolchain via rustup

## Elixir

| File | Indicates |
|------|-----------|
| `mix.exs` | Elixir project |
| `config/prod.exs` | Phoenix (preview: 4000) |

### Build.sh additions
- Erlang + Elixir
- inotify-tools (for Phoenix live reload)

## Database / Services

Look for these in docker-compose.yml, .env files, or framework config:

| Service | Indicator | Build.sh |
|---------|-----------|----------|
| PostgreSQL | `postgres` in compose, `pg` gems/packages | `postgresql-client` |
| MySQL/MariaDB | `mysql`/`mariadb` in compose | `mariadb-client` |
| Redis | `redis` in compose or deps | `redis-tools` |
| MongoDB | `mongo` in compose or deps | `mongosh` |

## Docker

| File | Indicates |
|------|-----------|
| `Dockerfile` | Docker build (already in base image) |
| `docker-compose.yml`, `compose.yml` | Multi-service app — Docker already in base, no build.sh changes |

## CI Config

Check `.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile` for:
- Required runtime versions
- System dependencies installed in CI
- Test commands
- Environment variables needed
