import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { describeError } from "../api";
import { SafetMark } from "../icons";

export function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Inputs are uncontrolled (no `value`/`onChange`) on purpose — Chrome's password manager writes
   * directly into the DOM, and controlled inputs don't see the fill until the user nudges them.
   * Reading via FormData on submit means autofill + click works without any extra event hooks.
   */
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const agencySlug = ((data.get("agency_slug") as string | null) ?? "").trim();
    const username = ((data.get("username") as string | null) ?? "").trim();
    const password = (data.get("password") as string | null) ?? "";
    if (!username || !password) {
      setError("Enter a username and password.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await login(username, password, agencySlug || undefined);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" name="safet-login" onSubmit={onSubmit}>
        <div className="login-brand">
          <SafetMark size={46} />
          <div>
            <h1>
              safe<b>T</b> PTT
            </h1>
            <div className="sub">Dispatch Console</div>
          </div>
        </div>
        {error && <div className="banner error">{error}</div>}
        <label htmlFor="agency-slug">Agency / network (optional)</label>
        <input
          id="agency-slug"
          name="agency_slug"
          autoComplete="organization"
          placeholder="e.g. default or sunset-safety-agency"
        />
        <p className="login-hint">
          If your company gave you a network code, enter it here. Leave blank if you only have one agency or
          you use a platform owner account.
        </p>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          autoFocus
          autoComplete="username"
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
