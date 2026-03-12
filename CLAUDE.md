# Spark-GHC-Kalibri-Dashboard

## Deployment
This project runs on **Replit**. The GitHub repo (`louispetauton/Spark-GHC-Kalibri-Dashboard`) is connected to Replit.

## Pulling updates on Replit

Replit has a persistent `.replit` file that is always modified locally, which causes standard `git pull --rebase` to fail. Use this instead:

```bash
git fetch origin && git reset --hard origin/main && pkill -f vite; npm run dev
```

If `pkill -f vite` leaves orphaned processes occupying ports (5000, 5001, etc.), use:

```bash
fuser -k 5000/tcp 5001/tcp 5002/tcp && npm run dev
```

## Dev server
```bash
npm run dev
```
Runs on `http://localhost:5000` (or next available port if occupied).
