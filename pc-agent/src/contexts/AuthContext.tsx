import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const TOKEN_KEY = 'openclaw.jwt';

export type UserInfo = {
  id: string;
  email: string;
  name: string;
};

export type OrganizationInfo = {
  id: string;
  domain: string | null;
  name: string;
};

export type CompanyProfile = {
  orgId: string;
  name: string;
  description: string;
  mission: string;
  vision: string;
  updatedAt?: string;
};

type AuthContextValue = {
  token: string | null;
  user: UserInfo | null;
  organization: OrganizationInfo | null;
  role: 'admin' | 'member' | null;
  company: CompanyProfile | null;
  loading: boolean;
  isAdmin: boolean;
  authHeaders: () => HeadersInit;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
  updateCompany: (patch: Partial<Pick<CompanyProfile, 'name' | 'description' | 'mission' | 'vision'>>) => Promise<CompanyProfile | null>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function normalizeCompany(raw: Record<string, unknown> | null): CompanyProfile | null {
  if (!raw) return null;
  return {
    orgId: String(raw.orgId || ''),
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    mission: typeof raw.mission === 'string' ? raw.mission : '',
    vision: typeof raw.vision === 'string' ? raw.vision : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  };
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<UserInfo | null>(null);
  const [organization, setOrganization] = useState<OrganizationInfo | null>(null);
  const [role, setRole] = useState<'admin' | 'member' | null>(null);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const authHeaders = useCallback((): HeadersInit => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const refreshMe = useCallback(async () => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) {
      setUser(null);
      setOrganization(null);
      setRole(null);
      setCompany(null);
      setToken(null);
      setLoading(false);
      return;
    }
    setToken(t);
    try {
      const r = await fetch('/auth/me', { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
        setOrganization(null);
        setRole(null);
        setCompany(null);
        setToken(null);
        setLoading(false);
        return;
      }
      const d = await r.json();
      if (d.user) setUser(d.user);
      if (d.organization) setOrganization(d.organization);
      setRole(d.role === 'admin' ? 'admin' : d.role === 'member' ? 'member' : null);
      setCompany(normalizeCompany(d.company));
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      setOrganization(null);
      setRole(null);
      setCompany(null);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      type BootWin = Window & {
        __OPENCLAW_LISTEN_AUTO_LOGIN__?: boolean;
        __OPENCLAW_PC_AGENT_BEARER__?: string;
      };
      const w = window as BootWin;
      // Vite dev server: no injected bearer — mint JWT from pc-agent when not in production.
      if (import.meta.env.DEV && !localStorage.getItem(TOKEN_KEY)) {
        try {
          const r = await fetch('/auth/dev-session', { method: 'POST' });
          const d = (await r.json().catch(() => ({}))) as { token?: string };
          if (!cancelled && r.ok && typeof d.token === 'string' && d.token) {
            localStorage.setItem(TOKEN_KEY, d.token);
            setToken(d.token);
          }
        } catch {
          /* fall through — show login or try auto-session */
        }
      }
      if (
        w.__OPENCLAW_LISTEN_AUTO_LOGIN__ &&
        w.__OPENCLAW_PC_AGENT_BEARER__ &&
        !localStorage.getItem(TOKEN_KEY)
      ) {
        try {
          const r = await fetch('/auth/auto-session', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${String(w.__OPENCLAW_PC_AGENT_BEARER__)}`,
            },
          });
          const d = (await r.json().catch(() => ({}))) as { token?: string };
          if (!cancelled && r.ok && typeof d.token === 'string' && d.token) {
            localStorage.setItem(TOKEN_KEY, d.token);
            setToken(d.token);
          }
        } catch {
          /* fall through to refreshMe — user can log in manually */
        }
      }
      if (!cancelled) await refreshMe();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMe]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d.error === 'string' ? d.error : 'Login failed');
    const tok = d.token as string | undefined;
    if (!tok) throw new Error('No token returned');
    localStorage.setItem(TOKEN_KEY, tok);
    setToken(tok);
    if (d.user) setUser(d.user);
    if (d.organization) setOrganization(d.organization);
    setRole(d.role === 'admin' ? 'admin' : 'member');
    setCompany(normalizeCompany(d.company));
  }, []);

  const signup = useCallback(async (email: string, password: string, name: string) => {
    const r = await fetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(typeof d.error === 'string' ? d.error : 'Signup failed');
    const tok = d.token as string | undefined;
    if (!tok) throw new Error('No token returned');
    localStorage.setItem(TOKEN_KEY, tok);
    setToken(tok);
    if (d.user) setUser(d.user);
    if (d.organization) setOrganization(d.organization);
    setRole(d.role === 'admin' ? 'admin' : 'member');
    setCompany(normalizeCompany(d.company));
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setOrganization(null);
    setRole(null);
    setCompany(null);
  }, []);

  const updateCompany = useCallback(
    async (patch: Partial<Pick<CompanyProfile, 'name' | 'description' | 'mission' | 'vision'>>) => {
      const t = localStorage.getItem(TOKEN_KEY);
      if (!t) return null;
      const r = await fetch('/organization/company', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d.error === 'string' ? d.error : 'Save failed');
      const c = normalizeCompany(d.company);
      setCompany(c);
      return c;
    },
    [],
  );

  const isAdmin = role === 'admin';

  const value = useMemo(
    () => ({
      token,
      user,
      organization,
      role,
      company,
      loading,
      isAdmin,
      authHeaders,
      login,
      signup,
      logout,
      refreshMe,
      updateCompany,
    }),
    [token, user, organization, role, company, loading, isAdmin, authHeaders, login, signup, logout, refreshMe, updateCompany],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const c = useContext(AuthContext);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}

export function isCompanyProfileEmpty(c: CompanyProfile | null): boolean {
  if (!c) return true;
  return (
    !c.name?.trim() && !c.description?.trim() && !c.mission?.trim() && !c.vision?.trim()
  );
}
