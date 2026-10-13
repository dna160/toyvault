import { useState } from "react";
import { api } from "../lib/api";

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <form
        className="panel w-full max-w-sm p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.login(password);
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-xl font-semibold tracking-tight">
          Toy<span className="text-accent">Vault</span>
        </p>
        <p className="mt-1 text-sm text-muted">Read-only inventory viewer. Changes are made in Claude Desktop.</p>
        <label className="mt-6 block text-sm font-medium" htmlFor="pw">
          Viewer password
        </label>
        <input
          id="pw"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-line-2 bg-white px-3 py-2.5 outline-none focus:border-ink"
        />
        {error && <p className="mt-2 text-sm text-low">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 w-full rounded-lg bg-ink py-2.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
