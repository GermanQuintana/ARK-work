import { fetch as undiciFetch, Agent } from "undici";

// El servidor de ARK (HTTP/1.1) deja colgadas las peticiones que reutilizan una
// conexión keep-alive: la primera va bien y las siguientes se quedan esperando.
// Forzamos conexión nueva por petición (sin keep-alive) para evitarlo.
const noKeepAlive = new Agent({
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  pipelining: 0,
  headersTimeout: 60000,
  bodyTimeout: 60000,
});

export interface ArkConfig {
  baseUrl: string;
  tenant: string;
  username: string;
  password: string;
}

interface SigninResponse {
  accessToken: string;
  refreshToken: string;
  authorities?: unknown;
  username?: string;
}

type Query = Record<string, string | number | null | undefined>;

export class ArkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ArkError";
  }
}

export class ArkClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor(private readonly cfg: ArkConfig) {}

  private url(path: string, query?: Query): string {
    const u = new URL(this.cfg.baseUrl.replace(/\/$/, "") + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== null && v !== undefined) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async signin(): Promise<void> {
    const res = await this.fetchWithRetry(this.url("/auth/signin"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant: this.cfg.tenant,
        username: this.cfg.username,
        password: this.cfg.password,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ArkError(
        `Fallo de autenticación (${res.status}). Revisa ARK_TENANT / ARK_USERNAME / ARK_PASSWORD.`,
        res.status,
        body,
      );
    }
    const data = (await res.json()) as SigninResponse;
    this.accessToken = data.accessToken;
    this.refreshToken = data.refreshToken;
  }

  private async ensureAuth(): Promise<void> {
    if (!this.accessToken) await this.signin();
  }

  // Petición con timeout. Reintenta ante errores de red / timeout, que en la
  // práctica ocurren al reutilizar una conexión keep-alive que el servidor ya
  // cerró (típico en la primera petición tras el signin). Cada reintento abre
  // una conexión nueva.
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    attempts = 3,
    timeoutMs = 60000,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return (await undiciFetch(url, {
          ...(init as Record<string, unknown>),
          dispatcher: noKeepAlive,
          signal: AbortSignal.timeout(timeoutMs),
        })) as unknown as Response;
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new ArkError(
      `No se pudo conectar con ARK tras ${attempts} intentos: ${(lastErr as Error)?.message ?? lastErr}`,
      0,
    );
  }

  private async raw(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; readOnly?: boolean } = {},
    retry = true,
  ): Promise<unknown> {
    await this.ensureAuth();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchWithRetry(this.url(path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, opts.readOnly ? 3 : 1);

    if (res.status === 401 && retry) {
      this.accessToken = null;
      return this.raw(method, path, opts, false);
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new ArkError(
        `ARK ${method} ${path} respondió ${res.status}`,
        res.status,
        parsed,
      );
    }
    return parsed;
  }

  get(path: string, query?: Query): Promise<unknown> {
    return this.raw("GET", path, { query, readOnly: true });
  }

  putSearch(path: string, body: unknown, query?: Query): Promise<unknown> {
    return this.raw("PUT", path, { body, query, readOnly: true });
  }

  post(path: string, body: unknown, query?: Query): Promise<unknown> {
    return this.raw("POST", path, { body, query });
  }

  put(path: string, body: unknown, query?: Query): Promise<unknown> {
    return this.raw("PUT", path, { body, query });
  }
}
