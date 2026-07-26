import type { PlanRequest, PlanResponse } from '../types';

// 8000 is a common default and was already taken on the dev machine; 8787 keeps
// Swara out of the way of whatever else is running locally.
export const API_BASE_URL = 'http://localhost:8787';

async function serverError(response: Response): Promise<Error> {
  let message = `Server request failed (${response.status}).`;

  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const detail = (body as Record<string, unknown>).detail;
      const bodyMessage = (body as Record<string, unknown>).message;
      if (typeof detail === 'string') message = detail;
      if (typeof bodyMessage === 'string') message = bodyMessage;
    }
  } catch {
    const text = await response.text().catch(() => '');
    if (text) message = text;
  }

  return new Error(message);
}

export async function getHealth(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) throw await serverError(response);
}

export async function postPlan(request: PlanRequest): Promise<PlanResponse> {
  const response = await fetch(`${API_BASE_URL}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) throw await serverError(response);
  return (await response.json()) as PlanResponse;
}
