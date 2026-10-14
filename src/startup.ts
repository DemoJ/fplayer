import { api, ApiError, getToken, type User } from "./api";

export type StartupState = { initialized: boolean; setupExpired: boolean; user?: User };

export async function loadStartup(signal?: AbortSignal): Promise<StartupState> {
  if (getToken()) {
    try {
      const result = await api<{ user: User }>("/me", { signal });
      if (!result?.user || typeof result.user.id !== "number" || typeof result.user.username !== "string" || typeof result.user.role !== "string") {
        throw new ApiError("服务响应异常，请稍后重试");
      }
      return { initialized: true, setupExpired: false, user: result.user };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401 || error.code !== "SESSION_INVALID" && error.code !== "SESSION_REQUIRED") throw error;
      return { initialized: true, setupExpired: false };
    }
  }
  const result = await api<{ initialized: boolean; setupExpired?: boolean }>("/setup", { signal });
  if (typeof result?.initialized !== "boolean") throw new ApiError("服务响应异常，请稍后重试");
  return { initialized: result.initialized, setupExpired: Boolean(result.setupExpired) };
}
