/* eslint-disable max-lines -- 登录表单和首次 Neuraldeep 引导共用已有入口，避免在未受管 ui 模块新增文件。 */
import { useState } from "react";
import { isApiKeyAccess } from "@zcode/provider";
import { LoaderCircle, TriangleAlertIcon } from "lucide-react";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import {
  TID_LOGIN_API_KEY_CANCEL_BUTTON,
  TID_LOGIN_API_KEY_CONTINUE_BUTTON,
  TID_LOGIN_API_KEY_ERROR,
  TID_LOGIN_API_KEY_INPUT,
  TID_LOGIN_API_KEY_PROVIDER_ITEM,
  TID_LOGIN_API_KEY_PROVIDER_TRIGGER,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { renderOAuthProviderIcon } from "@/lib/oauthProviderIcon.js";
import {
  buildLoginApiKeyDefaultModelPreferenceFromSelection,
  buildLoginApiKeySkipSettings,
  resolveLoginApiKeyDefaultProvider,
  resolveLoginApiKeyTemplateId,
  resolveLoginApiKeyProviderLabel,
  shouldShowLoginApiKeyLink,
  type ApiKeyProviderChoice,
} from "@/login/LoginApiKeyForm.helpers.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

interface LoginApiKeyFormProps {
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onSkipped: () => void | Promise<void>;
}

export function LoginApiKeyForm({ onCancel, onSaved, onSkipped }: LoginApiKeyFormProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { modelSelectionService, providerSettingsService, settingService } = useServices();
  const markApiKeyLoginSuccess = useZCodeStore((state) => state.markApiKeyLoginSuccess);
  const [providerChoice, setProviderChoice] = useState<ApiKeyProviderChoice>(() =>
    resolveLoginApiKeyDefaultProvider(locale),
  );
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;

  const providerLabel = resolveLoginApiKeyProviderLabel(providerChoice);
  const templateId = resolveLoginApiKeyTemplateId(providerChoice);
  const templateAccess = providerSettingsView?.providerTemplates.find(
    (template) => template.templateId === templateId,
  )?.config.access;
  const apiKeyUrl = isApiKeyAccess(templateAccess) ? templateAccess.apiKeyManagementUrl : undefined;
  // 用户已经输入或回填 API Key 后，右侧获取入口会挤占密码输入区域。
  const showApiKeyLink = shouldShowLoginApiKeyLink(apiKeyValue, apiKeyUrl ?? undefined);

  const saveApiKeyProvider = async () => {
    const apiKey = apiKeyValue.trim();
    if (!apiKey) {
      setError(intl.formatMessage({ id: "login.apiKey.emptyError" }));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const template = (await providerSettingsService.getView()).providerTemplates.find(
        (item) => item.templateId === templateId,
      );
      if (!template || !isApiKeyAccess(template.config.access)) {
        setError(
          intl.formatMessage(
            { id: "login.apiKey.providerMissingError" },
            { provider: providerLabel },
          ),
        );
        return;
      }

      const created = await providerSettingsService.createPersonalProvider({
        templateId,
        initialConfig: { access: { type: template.config.access.type, apiKey } },
      });
      const defaultModelPreference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
        await modelSelectionService.getView(),
        created.providerId,
      );
      markApiKeyLoginSuccess(defaultModelPreference);
      await onSaved();
    } catch (saveError) {
      logger.error("[LoginEntry] 保存 API Key provider 失败", {
        templateId,
        error: saveError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.saveError" },
          {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          },
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const skipApiKeyProvider = async () => {
    setSkipping(true);
    setError(null);
    try {
      // 跳过只表示用户确认当前 provider family 运行域，不能写入空 API Key
      // 或触发 API Key 登录成功事件，否则后续模型选择会误以为已有可用凭据。
      await settingService.update(buildLoginApiKeySkipSettings(providerChoice, Date.now()));
      await onSkipped();
    } catch (skipError) {
      logger.error("[LoginEntry] 跳过 API Key 登录失败", {
        providerChoice,
        error: skipError,
      });
      setError(
        intl.formatMessage(
          { id: "login.apiKey.skipError" },
          {
            error: skipError instanceof Error ? skipError.message : String(skipError),
          },
        ),
      );
    } finally {
      setSkipping(false);
    }
  };

  const busy = saving || skipping;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "login.apiKey.title" })}
        </h2>
        <div className="space-y-2">
          <div>
            <Select
              value={providerChoice}
              onValueChange={(value) => setProviderChoice(value as ApiKeyProviderChoice)}
              disabled={busy}
            >
              <SelectTrigger
                id="login-api-key-provider"
                size="lg"
                className="h-10 w-full text-ui-base"
                data-testid={TID_LOGIN_API_KEY_PROVIDER_TRIGGER}
                aria-label={intl.formatMessage({
                  id: "login.apiKey.providerLabel",
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" className="rounded-lg">
                <SelectItem
                  value="zai"
                  className="rounded-md"
                  data-testid={testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, "zai")}
                >
                  {renderOAuthProviderIcon(ZAI_PROVIDER_ID, "size-4")}
                  {intl.formatMessage({ id: "login.apiKey.provider.zai" })}
                </SelectItem>
                <SelectItem
                  value="bigmodel"
                  className="rounded-md"
                  data-testid={testId(TID_LOGIN_API_KEY_PROVIDER_ITEM, "bigmodel")}
                >
                  {renderOAuthProviderIcon(BIGMODEL_PROVIDER_ID, "size-4")}
                  {intl.formatMessage({
                    id: "login.apiKey.provider.bigmodel",
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Input
              id="login-api-key"
              type="password"
              size="lg"
              className={`h-10 w-full text-ui-base ${showApiKeyLink ? "pr-28" : ""}`}
              data-testid={TID_LOGIN_API_KEY_INPUT}
              aria-label={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              value={apiKeyValue}
              placeholder={intl.formatMessage({
                id: "login.apiKey.placeholder",
              })}
              autoComplete="off"
              onChange={(event) => {
                setApiKeyValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && apiKeyValue.trim() && !busy) {
                  void saveApiKeyProvider();
                }
              }}
            />
            {showApiKeyLink ? (
              <button
                type="button"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ui-base font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  if (apiKeyUrl) {
                    platform.openExternal(apiKeyUrl);
                  }
                }}
              >
                {intl.formatMessage({ id: "login.apiKey.getApiKey" })}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" data-testid={TID_LOGIN_API_KEY_ERROR}>
          <TriangleAlertIcon className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col items-center gap-2">
        <Button
          type="button"
          className="h-10 w-fit min-w-50 px-6 text-ui-base font-medium"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CONTINUE_BUTTON}
          disabled={!apiKeyValue.trim() || busy}
          onClick={() => void saveApiKeyProvider()}
        >
          {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.apiKey.continue" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 w-fit min-w-50 px-6 text-ui-base font-medium"
          size="lg"
          data-testid={TID_LOGIN_API_KEY_CANCEL_BUTTON}
          disabled={busy}
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "login.apiKey.cancel" })}
        </Button>
        <Button
          type="button"
          variant="link"
          className="mt-0.5 h-7 w-fit text-ui-base text-foreground-subtle hover:text-foreground"
          data-testid={TID_LOGIN_API_KEY_SKIP_BUTTON}
          disabled={busy}
          onClick={() => void skipApiKeyProvider()}
        >
          {skipping ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "login.skip" })}
        </Button>
      </div>
    </div>
  );
}

export const NEURALDEEP_ONBOARDING_STORAGE_KEY = "neuraldeep.apiOnboarding.v1";
export const NEURALDEEP_TEMPLATE_ID = "neuraldeep";
export const NEURALDEEP_BASE_URL = "https://api.neuraldeep.ru/v1";
export const LOCAL_PROVIDER_BASE_URL = "https://api.cloudpersonal.ru/v1";
export const LOCAL_MODEL_ID = "qwen3.8-flash-next";

export type NeuraldeepOnboardingChoice = "neuraldeep" | "local";

export function isNeuraldeepApiOnboardingComplete(): boolean {
  try {
    return globalThis.localStorage?.getItem(NEURALDEEP_ONBOARDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markNeuraldeepApiOnboardingComplete(): void {
  localStorage.setItem(NEURALDEEP_ONBOARDING_STORAGE_KEY, "1");
}

export function normalizeProviderBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function NeuraldeepApiOnboarding({ onComplete }: { onComplete: () => void }) {
  const { locale } = useZCodeIntl();
  const russian = locale.toLowerCase().startsWith("ru");
  const text = (ru: string, en: string) => (russian ? ru : en);
  const { modelSelectionService, providerSettingsService } = useServices();
  const markApiKeyLoginSuccess = useZCodeStore((state) => state.markApiKeyLoginSuccess);
  const [choice, setChoice] = useState<NeuraldeepOnboardingChoice>("neuraldeep");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(LOCAL_PROVIDER_BASE_URL);
  const [modelId, setModelId] = useState(LOCAL_MODEL_ID);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (preferredModel: string | null) => {
    markNeuraldeepApiOnboardingComplete();
    markApiKeyLoginSuccess(preferredModel);
    onComplete();
  };

  const save = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError(text("Введите API-ключ.", "Enter an API key."));
      return;
    }
    const customUrl = choice === "local" ? normalizeProviderBaseUrl(baseUrl) : NEURALDEEP_BASE_URL;
    if (!customUrl) {
      setError(
        text(
          "Введите адрес провайдера, например https://host/v1.",
          "Enter a provider URL, for example https://host/v1.",
        ),
      );
      return;
    }
    const customModel = modelId.trim() || LOCAL_MODEL_ID;
    setSaving(true);
    setError(null);
    try {
      const created =
        choice === "neuraldeep"
          ? await providerSettingsService.createPersonalProvider({
              templateId: NEURALDEEP_TEMPLATE_ID,
              providerName: "Neuraldeep",
              locale: locale === "zh-CN" ? "zh-CN" : "en-US",
              initialConfig: { access: { type: "api-key", apiKey: key } },
            })
          : await providerSettingsService.createPersonalProvider({
              providerName: "Custom",
              locale: locale === "zh-CN" ? "zh-CN" : "en-US",
              initialConfig: {
                access: { type: "api-key", apiKey: key },
                api: { type: "openai-chat-completions", baseUrl: customUrl },
              },
            });
      if (choice === "local") {
        await providerSettingsService.addPersonalModel(created.providerId, customModel, {
          enabled: true,
        });
      }
      const preference = buildLoginApiKeyDefaultModelPreferenceFromSelection(
        await modelSelectionService.getView(),
        created.providerId,
      );
      finish(preference);
    } catch (cause) {
      logger.error("[Neuraldeep] не удалось сохранить провайдера", { error: cause });
      setError(
        text("Не удалось сохранить провайдера: ", "Could not save the provider: ") +
          (cause instanceof Error ? cause.message : String(cause)),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <DesktopOverlayWindowControls />
      <section className="w-full max-w-md space-y-5 rounded-2xl border border-popover-border bg-background p-6 shadow-md">
        <div className="space-y-1">
          <h1 className="text-ui-lg font-semibold">Neuraldeep</h1>
          <p className="text-ui-base text-foreground-subtle">
            {text(
              "При первом запуске укажите ключ Neuraldeep или локальный OpenAI-совместимый API. Для локального адреса сертификат не проверяется.",
              "On first launch, enter the Neuraldeep key or your local OpenAI-compatible API. The local address skips certificate checks.",
            )}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={choice === "neuraldeep" ? "default" : "outline"}
            onClick={() => setChoice("neuraldeep")}
            disabled={saving}
          >
            Neuraldeep
          </Button>
          <Button
            type="button"
            variant={choice === "local" ? "default" : "outline"}
            onClick={() => setChoice("local")}
            disabled={saving}
          >
            {text("Локальный API", "Local API")}
          </Button>
        </div>
        {choice === "neuraldeep" ? (
          <p className="break-all text-ui-sm text-foreground-subtle">{NEURALDEEP_BASE_URL}</p>
        ) : (
          <div className="space-y-2">
            <Input
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              aria-label={text("Адрес API провайдера", "Provider API URL")}
              disabled={saving}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <Input
              value={modelId}
              aria-label={text("Идентификатор модели", "Model id")}
              disabled={saving}
              onChange={(event) => setModelId(event.target.value)}
            />
            <p className="text-ui-sm text-foreground-subtle">
              {text(
                "Для этого адреса и частных IP сертификат не проверяется.",
                "Certificate checks are skipped for this address and private IPs.",
              )}
            </p>
          </div>
        )}
        <Input
          type="password"
          value={apiKey}
          placeholder={text("API-ключ", "API key")}
          aria-label={text("API-ключ", "API key")}
          autoComplete="off"
          disabled={saving}
          onChange={(event) => {
            setApiKey(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && apiKey.trim() && !saving) void save();
          }}
        />
        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button type="button" disabled={saving || !apiKey.trim()} onClick={() => void save()}>
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {text("Продолжить", "Continue")}
          </Button>
          <Button
            type="button"
            variant="link"
            className="text-foreground-subtle"
            disabled={saving}
            onClick={() => finish(null)}
          >
            {text("Пропустить", "Skip for now")}
          </Button>
        </div>
      </section>
    </main>
  );
}
