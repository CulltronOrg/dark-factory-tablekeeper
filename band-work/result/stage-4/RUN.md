# Run

Build and start the service:

```sh
docker build -t nightshift .
docker run --rm -e PORT=8080 -p 8080:8080 nightshift
```

The process listens on `0.0.0.0` and the port in `PORT` (default `8080`). No other setup is required. `GET /health` returns `{"status":"ok"}` when the service can take requests.
