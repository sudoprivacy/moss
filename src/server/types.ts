import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import type { SessionRuntimeInfo, SessionRuntimeOptions, SessionRuntimeType } from './sessionManager.js'

export const runtimeInfoSchema = lazySchema(() =>
  z.object({
    type: z.enum(['host', 'docker', 'k8s']),
    engine: z.enum(['scode']).optional(),
    scodePath: z.string().optional(),
    dockerImage: z.string().optional(),
    dockerMode: z.enum(['session', 'user']).optional(),
    hostMode: z.enum(['session', 'user']).optional(),
    containerName: z.string().optional(),
    configDir: z.string().optional(),
    k8sImage: z.string().optional(),
    k8sNamespace: z.string().optional(),
    k8sRuntimeClassName: z.string().optional(),
    k8sMode: z.enum(['session', 'user']).optional(),
  }),
)

export const connectResponseSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    ws_url: z.string(),
    work_dir: z.string().optional(),
    runtime: runtimeInfoSchema().optional(),
  }),
)

export const attachSessionResponseSchema = lazySchema(() =>
  z.object({
    session: z.object({
      sessionId: z.string(),
      transcriptSessionId: z.string(),
      workDir: z.string(),
      userId: z.string(),
      orgId: z.string(),
      role: z.string(),
      scopes: z.array(z.string()),
      runtime: runtimeInfoSchema(),
      status: z.string(),
      desiredState: z.string(),
      createdAt: z.number(),
      lastActiveAt: z.number(),
      endedAt: z.number().nullable().optional(),
    }),
    ws_url: z.string(),
  }),
)

export const serverFileConfigSchema = lazySchema(() =>
  z.object({
    server: z.object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().min(0).default(43127),
      advertisedHost: z.string().min(1).optional(),
      // Public origin (scheme+host[:port], no trailing slash) prepended to
      // browser-loadable wiki-asset URLs. Empty → root-relative URLs (works
      // when client and server share an origin). Env: MOSS_PUBLIC_BASE_URL.
      publicBaseUrl: z.string().optional(),
      // Stable instance identity for multi-instance LB deployments (route cookie
      // value + server_instances key). Env: MOSS_INSTANCE_ID. Unset → random UUID
      // per start (single-instance behavior, unchanged).
      // Charset-restricted: the value is interpolated verbatim into Set-Cookie and
      // must stay a valid cookie value / nginx map key (';'/'='/space/CRLF would
      // break the header or make setHeader throw → every request 500s).
      instanceId: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
      // Route cookie name/secure flag for Nginx sticky routing. Env:
      // MOSS_ROUTE_COOKIE_NAME / MOSS_ROUTE_COOKIE_SECURE. The name must match
      // the nginx `map $cookie_...` key; changing it without updating nginx
      // silently degrades sticky routing to the pool.
      routeCookieName: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
      routeCookieSecure: z.boolean().optional(),
      // Grace period after SIGTERM: keep serving existing WS/SSE before forced
      // exit (0 = disabled, current behavior). Env: MOSS_SHUTDOWN_GRACE_MS.
      shutdownGraceMs: z.number().int().min(0).optional(),
    }).default({
      host: '0.0.0.0',
      port: 43127,
    }),
    auth: z.object({
      mode: z.enum(['local', 'auth-center']).default('local'),
      tokenTtlSec: z.number().int().min(60).default(60 * 60),
      authCenterUrl: z.string().min(1).optional(),
    }).default({
      mode: 'local',
      tokenTtlSec: 60 * 60,
    }),
    bootstrapAdmin: z.object({
      username: z.string().min(1).default('admin'),
      password: z.string().min(1).optional(),
      email: z.string().min(1).optional(),
    }).default({
      username: 'admin',
    }),
    storage: z.object({
      rootDir: z.string().min(1).optional(),
      dbPath: z.string().min(1).optional(),
      transcriptDir: z.string().min(1).optional(),
      runtimeDir: z.string().min(1).optional(),
    }).default({}),
    runtimeDefaults: z.object({
      type: z.enum(['host', 'docker', 'k8s']).default('host'),
      engine: z.enum(['scode']).default('scode'),
      scodePath: z.string().optional(),
      hostScodePath: z.string().optional(),
      dockerScodePath: z.string().optional(),
      dockerImage: z.string().optional(),
      dockerMode: z.enum(['session', 'user']).default('session'),
      workspace: z.string().optional(),
      idleTimeoutMs: z.number().int().min(0).default(10 * 60 * 1000),
      maxSessions: z.number().int().min(0).default(32),
    }).default({
      type: 'host',
      engine: 'scode',
      dockerMode: 'session',
      idleTimeoutMs: 10 * 60 * 1000,
      maxSessions: 32,
    }),
    docker: z.object({
      network: z.string().optional(),
      stopTimeoutSec: z.number().int().min(1).default(10),
      labels: z.record(z.string(), z.string()).default({}),
      /**
       * Container reuse boundary. 'session' (default) preserves legacy
       * `docker run --rm` per session. 'user' activates per-user long-lived
       * containers with `docker exec` per session.
       */
      containerMode: z.enum(['session', 'user']).default('session'),
      maxSessionsPerUser: z.number().int().min(1).default(5),
      userContainerIdleTimeoutMs: z.number().int().min(60_000).default(20 * 60_000),
      execKillGraceMs: z.number().int().min(0).default(5_000),
      /** Per-user container resource gates (only relevant when containerMode='user'). */
      user: z.object({
        pidsLimit: z.number().int().min(64).default(512),
        memory: z.string().default('4g'),
        cpus: z.string().default('2'),
        nofile: z.number().int().min(256).default(4096),
      }).default({
        pidsLimit: 512,
        memory: '4g',
        cpus: '2',
        nofile: 4096,
      }),
    }).default({
      stopTimeoutSec: 10,
      labels: {},
      containerMode: 'session',
      maxSessionsPerUser: 5,
      userContainerIdleTimeoutMs: 20 * 60_000,
      execKillGraceMs: 5_000,
      user: {
        pidsLimit: 512,
        memory: '4g',
        cpus: '2',
        nofile: 4096,
      },
    }),
    // gvisor-isolated k8s pod runtime (single-node k3s PoC). Only consulted
    // when runtimeDefaults.type='k8s' or a session requests runtime.type='k8s'.
    k8s: z.object({
      image: z.string().optional(),
      namespace: z.string().default('moss-sessions'),
      // Empty string → omit runtimeClassName (customer cluster without gvisor).
      runtimeClassName: z.string().default('gvisor'),
      kubeconfig: z.string().optional(),
      // Pod imagePullPolicy. IfNotPresent works for both a node-imported image
      // (our k3s flow) and a customer registry image (pulled when absent).
      imagePullPolicy: z.string().default('IfNotPresent'),
      // Names of pre-created dockerconfigjson pull secrets (private registries).
      imagePullSecrets: z.array(z.string()).default([]),
      cpuLimit: z.string().default('2'),
      memoryLimit: z.string().default('4Gi'),
      podReadyTimeoutSec: z.number().int().min(1).default(90),
      labels: z.record(z.string(), z.string()).default({}),
    }).default({
      namespace: 'moss-sessions',
      runtimeClassName: 'gvisor',
      imagePullPolicy: 'IfNotPresent',
      imagePullSecrets: [],
      cpuLimit: '2',
      memoryLimit: '4Gi',
      podReadyTimeoutSec: 90,
      labels: {},
    }),
    recovery: z.object({
      startupPolicy: z.enum(['reattach-or-resume']).default('reattach-or-resume'),
      heartbeatTimeoutMs: z.number().int().min(1).default(30_000),
      reattachProbeTimeoutMs: z.number().int().min(1).default(3_000),
      resumeOnMissingRuntime: z.boolean().default(true),
    }).default({
      startupPolicy: 'reattach-or-resume',
      heartbeatTimeoutMs: 30_000,
      reattachProbeTimeoutMs: 3_000,
      resumeOnMissingRuntime: true,
    }),
    logging: z.object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      auditFile: z.string().optional(),
    }).default({
      level: 'info',
    }),
    hub: z.object({
      apiBaseUrl: z.string().optional(),
      authorization: z.string().optional(),
      cosBaseUrl: z.string().optional(),
    }).default({}),
    wikiIndex: z.object({
      enabled: z.boolean().default(true),
      modelId: z.string().default('Xenova/multilingual-e5-small'),
      modelMirror: z.string().url().optional(),
      maxPassagesPerWiki: z.number().int().min(100).default(20_000),
      topKVector: z.number().int().min(1).max(200).default(50),
      // HMAC secret keying the opaque tokens in public wiki-image URLs. Change
      // it and every previously-issued image URL 404s. Env:
      // MOSS_RESOURCE_TOKEN_SECRET.
      resourceTokenSecret: z.string().default('dev-resource-token-secret'),
    }).default({
      enabled: true,
      modelId: 'Xenova/multilingual-e5-small',
      maxPassagesPerWiki: 20_000,
      topKVector: 50,
      resourceTokenSecret: 'dev-resource-token-secret',
    }),
    cabin: z.object({
      enabled: z.boolean().default(false),
      tokenSecret: z.string().default('dev-cabin-token-secret'),
      tokenTtlSeconds: z.number().int().min(60).default(2 * 60 * 60),
      passengerInfoUrl: z.string().optional(),
      passengerInfoAuth: z.string().optional(),
      passengerInfoPrivacyLevel: z.number().int().min(1).max(3).default(2),
      aircraftNo: z.string().optional(),
      asrUrl: z.string().default('http://127.0.0.1:8002/v1/audio/transcriptions'),
      asrModel: z.string().default('Qwen/Qwen3-ASR-1.7B'),
      asrApiKey: z.string().optional(),
      ttsUrl: z.string().default('http://127.0.0.1:8004/v1/audio/speech'),
      ttsModel: z.string().default('qwen3-tts'),
      ttsVoice: z.string().default('vivian'),
      ttsLanguage: z.string().default('chinese'),
      ttsApiKey: z.string().optional(),
      llmBaseUrl: z.string().default('http://127.0.0.1:8000/v1'),
      llmModel: z.string().default('Qwen3.6-35B-A3B-NVFP4'),
      llmApiKey: z.string().optional(),
      controlBaseUrl: z.string().optional(),
      controlAuth: z.string().optional(),
      controlTimeoutMs: z.number().int().min(1000).default(10_000),
      automationEnabled: z.boolean().default(false),
      flightStateWsUrl: z.string().optional(),
      flightStateWsConnectTimeoutMs: z.number().int().min(1000).default(10_000),
      flightStateWsHeartbeatIntervalMs: z.number().int().min(0).default(15_000),
      flightStateWsIdleTimeoutMs: z.number().int().min(0).default(60_000),
      flightStateWsReconnectMinMs: z.number().int().min(100).default(3_000),
      flightStateWsReconnectMaxMs: z.number().int().min(100).default(30_000),
      managedSeats: z.string().optional(),
      broadcastBaseUrl: z.string().optional(),
      broadcastApiBaseUrl: z.string().optional(),
      broadcastApiKey: z.string().optional(),
      broadcastAuth: z.string().optional(),
      broadcastEnabled: z.boolean().default(true),
      broadcastTtsCacheDir: z.string().optional(),
      broadcastTtsVersion: z.string().default('flight-phase-v1'),
      automationLogFile: z.string().optional(),
      healthReportEnabled: z.boolean().default(false),
      healthReportCollectSeconds: z.number().int().min(1).default(30),
      healthReportMinSamples: z.number().int().min(1).default(1),
      assistantName: z.string().default('cabin-ai-flight-attendant'),
      assistantDisplayName: z.string().optional(),
      createMossSession: z.boolean().default(false),
      replyTimeoutMs: z.number().int().min(1000).default(45_000),
      sessionRecoveryEnabled: z.boolean().default(true),
      sessionRecoveryMaxAttempts: z.number().int().min(0).max(3).default(1),
      contextReplayTurns: z.number().int().min(0).max(200).default(20),
      flightStateDemoEnabled: z.boolean().default(false),
      demoPlaybackUrl: z.string().optional(),
      demoAlertUrl: z.string().optional(),
      logEnabled: z.boolean().default(true),
      logFile: z.string().optional(),
    }).default({
      enabled: false,
      tokenSecret: 'dev-cabin-token-secret',
      tokenTtlSeconds: 2 * 60 * 60,
      passengerInfoPrivacyLevel: 2,
      asrUrl: 'http://127.0.0.1:8002/v1/audio/transcriptions',
      asrModel: 'Qwen/Qwen3-ASR-1.7B',
      ttsUrl: 'http://127.0.0.1:8004/v1/audio/speech',
      ttsModel: 'qwen3-tts',
      ttsVoice: 'vivian',
      ttsLanguage: 'chinese',
      llmBaseUrl: 'http://127.0.0.1:8000/v1',
      llmModel: 'Qwen3.6-35B-A3B-NVFP4',
      controlTimeoutMs: 10_000,
      automationEnabled: false,
      broadcastEnabled: true,
      broadcastTtsVersion: 'flight-phase-v1',
      healthReportEnabled: false,
      healthReportCollectSeconds: 30,
      healthReportMinSamples: 1,
      assistantName: 'cabin-ai-flight-attendant',
      assistantDisplayName: '客舱 AI 乘务员',
      createMossSession: false,
      replyTimeoutMs: 45_000,
      sessionRecoveryEnabled: true,
      sessionRecoveryMaxAttempts: 1,
      contextReplayTurns: 20,
      flightStateDemoEnabled: false,
      logEnabled: true,
    }),
    /**
     * Phone + verification-code auth — the self-service signup path behind
     * `login_method: 0`. Off by default: the endpoints refuse until a
     * deployment turns them on, because the only delivery transport that ships
     * writes codes to the server log.
     */
    phoneAuth: z.object({
      enabled: z.boolean().default(false),
      /**
       * `log` writes the code to the server log — development only.
       * `tencent` sends real SMS; its credentials come from the Nexus vault,
       * never from this file (see the `tencent` block below for the non-secret
       * half, and smsTencent.ts for why).
       */
      delivery: z.enum(['log', 'tencent']).default('log'),
      /** Non-secret Tencent Cloud SMS settings. Required when delivery='tencent'. */
      tencent: z.object({
        sdkAppId: z.string().min(1),
        signName: z.string().min(1),
        templateId: z.string().min(1),
        region: z.string().min(1).default('ap-beijing'),
        /**
         * Ordered values for the template's {1}, {2}, … placeholders.
         * `{code}` and `{ttlMinutes}` are substituted. The default matches a
         * template of the form "{1} is your code, valid for {2} minutes";
         * a single-parameter template sets `["{code}"]`.
         */
        templateParams: z.array(z.string()).min(1).default(['{code}', '{ttlMinutes}']),
        /** Vault namespace/keys holding the credential pair. */
        vaultNamespace: z.string().min(1).default('system:sms'),
        secretIdKey: z.string().min(1).default('tencent_secret_id'),
        secretKeyKey: z.string().min(1).default('tencent_secret_key'),
      }).optional(),
      codeTtlSec: z.number().int().min(60).max(3600).default(300),
      resendCooldownSec: z.number().int().min(0).max(600).default(60),
      maxSendsPerHour: z.number().int().min(1).max(100).default(5),
      maxVerifyAttempts: z.number().int().min(1).max(20).default(5),
      /** When set, registration additionally requires this invitation code. */
      invitationCode: z.string().min(1).optional(),
      /**
       * Give each new person their own organisation (one-person company) — the
       * public-cloud shape, and what makes an individual an organisation of one
       * rather than a second tenancy model. Turn off for a single-company
       * deployment, where new people join the organisation that already exists.
       */
      autoCreateOrg: z.boolean().default(true),
    }).default({
      enabled: false,
      delivery: 'log',
      codeTtlSec: 300,
      resendCooldownSec: 60,
      maxSendsPerHour: 5,
      maxVerifyAttempts: 5,
      autoCreateOrg: true,
    }),
    /**
     * Public, unauthenticated client bootstrap (`GET /api/v1/system-config`).
     *
     * This is the seam that lets one binary serve Sudo Cloud and Sudo Private:
     * the client asks the server how to log in and where the satellite services
     * are, instead of hard-coding either. See `publicSystemConfig.ts` for the
     * wire contract and for what must never be put in here.
     *
     * Defaults describe a self-hosted deployment: username/password login (the
     * only method moss implements today), no billing, and every phone-home
     * feature OFF. A public-cloud deployment turns those on explicitly.
     */
    systemConfig: z.object({
      /** 0 = phone code, 1 = username/password, 2 = third-party (CAS). */
      loginMethod: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
      thirdPartyAuth: z.object({
        enabled: z.boolean().default(true),
        defaultProvider: z.string().min(1).optional(),
        providers: z.array(z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          type: z.literal('cas'),
          casUrl: z.string().min(1),
          loginPath: z.string().optional(),
          validatePath: z.string().optional(),
          logoutPath: z.string().optional(),
          logoutServiceUrl: z.string().optional(),
          serviceParam: z.string().optional(),
          serviceEncodeMode: z.enum(['raw', 'component']).optional(),
          callbackMode: z.enum(['server_callback', 'direct_app']).optional(),
          serverCallbackUrl: z.string().optional(),
          appCallbackUrl: z.string().optional(),
        })).default([]),
      }).optional(),
      /**
       * Sudorouter ROOT url (no `/v1`) — call sites append their own path. Unset
       * derives it from the system settings' model service url.
       */
      sudorouterBaseUrl: z.string().min(1).optional(),
      skillhubBaseUrl: z.string().min(1).optional(),
      scodeAutoModel: z.string().min(1).optional(),
      /**
       * `disabled` because moss holds no credit ledger of its own. `approve`
       * turns on credit applications, where an administrator grants points and
       * moss credits them at the gateway. `pay` additionally needs a payment
       * provider (the client expects an Alipay / WeChat QR), which moss does
       * not implement — setting it without one leaves the purchase flow dead.
       */
      rechargeMode: z.enum(['pay', 'approve', 'disabled']).default('disabled'),
      /**
       * Points granted to a newly provisioned gateway account. 0 means the
       * account is created with nothing, which is the right default for a
       * deployment that has not decided to give anything away.
       */
      initialPoints: z.number().int().min(0).default(0),
      creditApplication: z.object({
        minPoints: z.number().int().min(0),
        maxPoints: z.number().int().min(0),
        allowDuplicatePending: z.boolean().default(false),
      }).default({ minPoints: 100, maxPoints: 1000000, allowDuplicatePending: false }),
      logReport: z.object({
        enabled: z.boolean().default(false),
        baseUrl: z.string().min(1).optional(),
      }).optional(),
      versionUpdate: z.object({
        enabled: z.boolean().default(false),
        cosDomain: z.string().min(1).optional(),
      }).optional(),
      productImprovement: z.object({
        enabled: z.boolean().default(false),
        encryptionRequired: z.boolean().optional(),
      }).optional(),
    }).default({
      loginMethod: 1,
      rechargeMode: 'disabled',
    }),
  }),
)

export type ServerFileConfig = z.infer<ReturnType<typeof serverFileConfigSchema>>
export type SystemConfigFileSection = ServerFileConfig['systemConfig']
export type PhoneAuthFileSection = ServerFileConfig['phoneAuth']

export type ServerConfig = {
  host: string
  port: number
  /**
   * 企业应用管理: optional dedicated port for the PUBLIC corp-app callback
   * listener (WeCom etc.). Runs a separate http.Server that ONLY serves the
   * callback route, isolating external traffic from the admin/API server.
   * Resolved from MOSS_CALLBACK_PORT when unset. Disabled if 0/undefined.
   */
  callbackPort?: number
  advertisedHost?: string
  /**
   * Public origin prepended to browser-loadable wiki-asset URLs (see
   * server.publicBaseUrl in the file config). Empty string → root-relative.
   */
  publicBaseUrl: string
  /**
   * Stable instance identity for multi-instance LB deployments: route cookie
   * value + server_instances key. Env: MOSS_INSTANCE_ID. Unset → random UUID
   * per start (single-instance behavior). Charset-restricted
   * (`/^[A-Za-z0-9_-]+$/`, enforced in resolveServerConfig for env and file
   * values alike) because it is interpolated into Set-Cookie.
   */
  instanceId?: string
  /** Route cookie name for Nginx sticky routing (default `moss_route`). */
  routeCookieName: string
  /** Append `Secure` to the route cookie (set true behind TLS). */
  routeCookieSecure: boolean
  /**
   * Grace period after SIGTERM: keep serving existing WS/SSE before forced
   * exit. 0 (default) = disabled — stop() proceeds straight to the existing
   * cleanup chain, preserving single-instance behavior.
   */
  shutdownGraceMs: number
  authMode: 'local'
  tokenTtlSec: number
  bootstrapAdmin: {
    username: string
    password?: string
    email?: string
  }
  workspace?: string
  defaultRuntime: SessionRuntimeType
  engine: 'scode'
  scodePath?: string
  hostScodePath?: string
  dockerScodePath?: string
  dockerImage?: string
  dockerMode?: 'session' | 'user'
  idleTimeoutMs: number
  maxSessions: number
  rootDir: string
  dbPath: string
  transcriptDir: string
  runtimeDir: string
  dockerNetwork?: string
  dockerStopTimeoutSec: number
  dockerLabels: Record<string, string>
  /**
   * Per-user docker container settings. `containerMode='session'` is the
   * default and preserves legacy `docker run --rm` per-session behavior. Set
   * `containerMode='user'` to activate long-lived per-user containers + per-
   * session `docker exec`. `session.maxDetachedBusyMs` controls the upper
   * bound on detached + busy sessions before persistInProgressTurn + force
   * destroy.
   */
  docker?: {
    containerMode: 'session' | 'user'
    maxSessionsPerUser: number
    userContainerIdleTimeoutMs: number
    execKillGraceMs: number
    user: {
      pidsLimit: number
      memory: string
      cpus: string
      nofile: number
    }
  }
  /**
   * gvisor-isolated k8s pod runtime settings (single-node k3s PoC). Consumed
   * by K8sBackend when a session's runtime.type='k8s'. Env overrides:
   * MOSS_SCODE_IMAGE, MOSS_K8S_NAMESPACE, MOSS_K8S_RUNTIME_CLASS,
   * MOSS_K8S_KUBECONFIG. (scode ships in the image — no node-side path.)
   */
  k8s?: {
    image?: string
    namespace: string
    runtimeClassName: string
    kubeconfig?: string
    imagePullPolicy: string
    imagePullSecrets: string[]
    cpuLimit: string
    memoryLimit: string
    podReadyTimeoutSec: number
    labels: Record<string, string>
  }
  session?: {
    maxDetachedBusyMs: number
  }
  startupPolicy: 'reattach-or-resume'
  heartbeatTimeoutMs: number
  reattachProbeTimeoutMs: number
  resumeOnMissingRuntime: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  auditFile?: string
  hubApiBaseUrl?: string
  hubAuthorization?: string
  cosBaseUrl?: string
  /**
   * Local vector index for wiki semantic search. When `enabled=true`,
   * WikiJobExecutor builds a Float32 embedding sidecar at wiki publish time
   * and the agent search route falls back to grep+vec RRF fusion. Model
   * absence is non-fatal: build degrades to grep-only, runtime warns once
   * per process. Env override: MOSS_WIKI_INDEX_DISABLED=1 force-disables.
   */
  wikiIndex: {
    enabled: boolean
    modelId: string
    modelMirror?: string
    maxPassagesPerWiki: number
    topKVector: number
    /** HMAC secret keying opaque tokens in public wiki-image URLs. */
    resourceTokenSecret: string
  }
  cabin: {
    enabled: boolean
    tokenSecret: string
    tokenTtlSeconds: number
    passengerInfoUrl?: string
    passengerInfoAuth?: string
    passengerInfoPrivacyLevel: number
    aircraftNo?: string
    asrUrl: string
    asrModel: string
    asrApiKey?: string
    ttsUrl: string
    ttsModel: string
    ttsVoice: string
    ttsLanguage: string
    ttsApiKey?: string
    llmBaseUrl: string
    llmModel: string
    llmApiKey?: string
    controlBaseUrl?: string
    controlAuth?: string
    controlTimeoutMs: number
    automationEnabled: boolean
    flightStateWsUrl?: string
    flightStateWsConnectTimeoutMs: number
    flightStateWsHeartbeatIntervalMs: number
    flightStateWsIdleTimeoutMs: number
    flightStateWsReconnectMinMs: number
    flightStateWsReconnectMaxMs: number
    managedSeats?: string
    broadcastBaseUrl?: string
    broadcastApiBaseUrl?: string
    broadcastApiKey?: string
    broadcastAuth?: string
    broadcastEnabled?: boolean
    broadcastTtsCacheDir?: string
    broadcastTtsVersion?: string
    automationLogFile?: string
    healthReportEnabled: boolean
    healthReportCollectSeconds: number
    healthReportMinSamples: number
    assistantName: string
    assistantDisplayName?: string
    createMossSession: boolean
    replyTimeoutMs: number
    sessionRecoveryEnabled: boolean
    sessionRecoveryMaxAttempts: number
    contextReplayTurns: number
    flightStateDemoEnabled: boolean
    demoPlaybackUrl?: string
    demoAlertUrl?: string
    logEnabled: boolean
    logFile?: string
  }
  /** Public client bootstrap — see the schema section of the same name. */
  systemConfig: SystemConfigFileSection
  /** Phone + code auth — see the schema section of the same name. */
  phoneAuth: PhoneAuthFileSection
}

export type SessionStatus =
  | 'creating'
  | 'active'
  | 'detached'
  | 'ended'
  | 'terminated'
  | 'failed'
  | 'lost'

export type DesiredSessionState = 'active' | 'ended' | 'terminated'

export type AttemptRuntimeState =
  | 'starting'
  | 'running'
  | 'detached'
  | 'stopped'
  | 'failed'
  | 'lost'

export type SessionRecord = {
  sessionId: string
  transcriptSessionId: string
  orgId: string
  userId: string
  role: string
  scopes: string[]
  cwd: string
  runtime: SessionRuntimeInfo
  status: SessionStatus
  desiredState: DesiredSessionState
  currentAttemptId: string | null
  transcriptPath: string
  title: string | null
  summary: string | null
  assistantName: string | null
  source?: string
  channelChatId?: string
  clientMetadata?: Record<string, unknown>
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
  deletedAt: number | null
}

export type AttemptRecord = {
  attemptId: string
  sessionId: string
  generation: number
  backendType: SessionRuntimeType
  runtimeState: AttemptRuntimeState
  serverInstanceId: string | null
  runnerPid: number | null
  containerName: string | null
  attachPath: string | null
  resumeTranscriptSessionId: string
  startedAt: number
  lastHeartbeatAt: number | null
  stoppedAt: number | null
  exitCode: number | null
  exitSignal: string | null
  stopReason: string | null
  errorText: string | null
}

export type SessionEventRecord = {
  eventId: string
  sessionId: string
  attemptId: string | null
  eventType: string
  payload: Record<string, unknown>
  createdAt: number
}

export type ServerInstanceRecord = {
  instanceId: string
  host: string
  pid: number | null
  startedAt: number
  heartbeatAt: number
  stoppedAt: number | null
  status: 'running' | 'stopped'
}

export type SessionListFilter = {
  orgId: string
  userId?: string
  activeOnly?: boolean
  includeDeleted?: boolean
}

export type SessionSummary = {
  sessionId: string
  transcriptSessionId: string
  workDir: string
  userId: string
  orgId: string
  role: string
  scopes: string[]
  runtime: SessionRuntimeInfo
  status: SessionStatus
  desiredState: DesiredSessionState
  assistantName: string | null
  source?: string
  channelChatId?: string
  clientMetadata?: Record<string, unknown>
  createdAt: number
  lastActiveAt: number
  endedAt: number | null
}

export type SessionCreateInput = {
  cwd?: string
  dangerouslySkipPermissions: boolean
  userId: string
  orgId: string
  role: string
  scopes: string[]
  runtime?: SessionRuntimeOptions
  assistantName?: string
  assistantDisplayName?: string
  source?: string
  channelChatId?: string
  /** Enabled skill names (optional, for non-agent sessions) */
  enabledSkills?: string[]
}

export type EnterpriseRecord = {
  id: string
  logo: string | null
  app_name: string | null
  top_name: string | null
  about_name: string | null
  app_company_name: string | null
  login_desp: string | null
  /**
   * Whether the client-side cron (scheduled task) feature is available to
   * enterprise users. Stored as 0/1 in SQLite; null on rows predating the
   * column is treated as enabled (default on). Managed by admin/super_admin
   * only and surfaced to the client via GET /api/v1/tenant/config.
   */
  client_cron_enabled: boolean | null
  created_at: number
  updated_at: number
}

export type RunnerManifest = {
  config: ServerConfig
  session: {
    sessionId: string
    transcriptSessionId: string
    resumeFromTranscript: boolean
    cwd: string
    transcriptPath: string
    userId: string
    orgId: string
    role: string
    scopes: string[]
    dangerouslySkipPermissions: boolean
    runtime: SessionRuntimeInfo
    assistantName?: string
    assistantDisplayName?: string
    /**
     * Document Center v2: pre-signed JWT for the in-container `wiki` CLI
     * to call /api/v1/agent/wikis*. Carries `assistant_id` so server-side
     * filtering by enabledWikis works. RuntimeService signs it via
     * `authService.issueWikiSession` before spawning the runner; runner
     * threads it into `SESSION_TOKEN` env via `buildSessionEnv` overrides.
     */
    sessionToken?: string
    /**
     * Document Center v2: wikis this agent is authorized to query.
     * Resolved by RuntimeService.spawnAttempt from agent meta +
     * DocumentStore; surfaced to agent via acpBridge first-message
     * `[Available Wikis]` block so scode actually knows to use `wiki` CLI.
     */
    availableWikis?: Array<{ id: string; name: string; description?: string | null }>
    /**
     * Corp app instances this agent may use via the `corpapp` CLI.
     * acpBridge injects an `[Available Corp Apps]` block so the agent knows
     * the CLI + instance names exist.
     */
    availableCorpApps?: Array<{ id: string; name: string; type: string; key: string }>
    sharedMemory?: string | null
    /** Enabled skill names (from client or agent config) */
    enabledSkills?: string[]
    /**
     * 可见性过滤上下文，用于过滤用户有权访问的技能
     */
    visibilityFilter?: {
      isAdmin: boolean
      userId: string
      departmentId: string | null
      visibleDepartmentIds: string[] | null // Set 序列化为数组
    } | null
    /**
     * 用户可见 MCP 服务的 scode settings.json 内容（主进程解析后下发）。
     * 形如 { mcpServers: { name: {...} } }，由 backend 写入
     * `${configDir}/.nexus/sudocode/settings.json` 供 scode 启动时加载。
     */
    mcpSettings?: { mcpServers: Record<string, unknown> }
  }
  attempt: {
    attemptId: string
    generation: number
    runtimeDir: string
    attachPath: string
    stdoutLogPath: string
    stderrLogPath: string
    statusPath: string
  }
}
