import { useCallback, useEffect, useState } from "react";
import {
  getApiBase,
  getDoctor,
  getHealth,
  type DoctorResponse,
  type HealthResponse,
} from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Layout } from "../components/Layout";
import { LoadingState } from "../components/LoadingState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SettingsPage() {
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const loadDoctor = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getDoctor();
      setDoctor(data);
    } catch (err) {
      setError(err);
      setDoctor(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDoctor();
  }, [loadDoctor]);

  async function handleHealthCheck() {
    setCheckingHealth(true);
    setError(null);
    try {
      const data = await getHealth();
      setHealth(data);
    } catch (err) {
      setHealth(null);
      setError(err);
    } finally {
      setCheckingHealth(false);
    }
  }

  return (
    <Layout>
      <div data-testid="global-settings-page" className="flex flex-col gap-5">
        <header className="page-header row-between">
          <div>
            <h1>Settings</h1>
            <p>
              Provider credentials are process/user env only. This page shows local doctor diagnostics
              and API health.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadDoctor()}
            disabled={loading}
            data-testid="doctor-refresh"
          >
            Refresh doctor
          </Button>
        </header>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        <Card data-testid="health-panel">
          <CardHeader>
            <CardTitle>API connection</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="kv">
              <div>
                <dt>API base</dt>
                <dd className="mono">{getApiBase()}</dd>
              </div>
              <div>
                <dt>Health</dt>
                <dd>
                  {health ? (
                    <Badge
                      variant={health.ok ? "secondary" : "destructive"}
                      data-testid="health-status"
                    >
                      {health.ok ? `ok · ${health.service}` : "not ok"}
                    </Badge>
                  ) : (
                    <span className="muted">Not checked yet</span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="form-actions">
              <Button
                type="button"
                onClick={() => void handleHealthCheck()}
                disabled={checkingHealth}
              >
                {checkingHealth ? "Checking…" : "Run health check"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {loading ? (
          <LoadingState label="Loading doctor…" />
        ) : doctor ? (
          <Card data-testid="doctor-panel">
            <CardHeader>
              <CardTitle>Doctor</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <dl className="kv kv-grid">
                <div>
                  <dt>Status</dt>
                  <dd>
                    <Badge
                      variant={doctor.ok ? "secondary" : "destructive"}
                      data-testid="doctor-status"
                    >
                      {doctor.ok ? "ok" : "not ok"}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt>Node</dt>
                  <dd className="mono">{doctor.node}</dd>
                </div>
                <div>
                  <dt>Platform</dt>
                  <dd className="mono">
                    {doctor.platform}/{doctor.arch}
                  </dd>
                </div>
                <div>
                  <dt>Git</dt>
                  <dd>
                    {doctor.git.available ? (
                      <Badge variant="secondary">
                        available{doctor.git.version ? ` · ${doctor.git.version}` : ""}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">unavailable</Badge>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>OPENAI_BASE_URL</dt>
                  <dd className="mono">
                    {doctor.env.openaiBaseUrlSet ? "set" : "unset"}
                  </dd>
                </div>
                <div>
                  <dt>OPENAI_API_KEY</dt>
                  <dd className="mono">
                    {doctor.env.openaiApiKeySet ? "set" : "unset"}
                  </dd>
                </div>
              </dl>
              <p className="muted small">
                Secret values are never returned — flags only. Set credentials in the process or user
                environment before starting the server.
              </p>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Environment notes</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="kv">
              <div>
                <dt>OPENAI_BASE_URL</dt>
                <dd className="mono">set in environment (…/v1)</dd>
              </div>
              <div>
                <dt>OPENAI_API_KEY</dt>
                <dd className="mono">set / unset only in doctor</dd>
              </div>
              <div>
                <dt>API bind</dt>
                <dd className="mono">127.0.0.1:8787 (default)</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
