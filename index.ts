const _analytics_session_config = {
    session_data_key: "session_data", // storage key
    session_duration: 30, // session duration in minutes
    url_params: [
        'utm_id',
        'utm_campaign',
        'utm_term',
        'utm_content',
        'utm_source',
        'utm_medium',
        'utm_source_platform',
        'utm_creative_format',
        'utm_marketing_tactic',
        'gclid',
        'fbclid',
        'irclickid',
        'msclkid',
        'sscid',
        'ttclid'
    ] // query params to check at session generation
}

const _analytics_context_config = {
    timezone: function ():string {
        return Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    screen: function (): Record<string, number>{
        return { width: window.screen.width, height: window.screen.height }
    },
    location: function(): Record<string, any> {
        return { country: _cookie("geo"), ...JSON.parse(localStorage.currentLocation || "{}") }
    }
}

const _analytics_integration_config = {
    "Google Analytics": function (): Record<string, any> {
        let cid = _cookie("_ga");
        cid = cid? cid.split('.').slice(-2).join('.') : undefined
        return {
            clientId: cid,
            gclid: _analytics_session.data.campaign.gclid
        }
    },
    "Facebook Conversions API (Actions)": function (): Record<string, any> {
        return {
            fbp: _cookie("_fbp"),
            fbclid: _analytics_session.data.campaign.fbclid
        }
    }
}

type SessionData = {
    landing_page: string
    referrer: string
    campaign: Record<string, string | undefined> | undefined
}

type Session = {
    id: string
    start: number
    expires: number
    data: SessionData
}

type Context = {
    user?: SegmentUser
    session: Session
    active: boolean
    timezone: string
    screen: Record<string, number>
    page: Record<string, any>
    location: Record<string, any>
}

interface SegmentAnalytics {
    user(): SegmentUser
    addSourceMiddleware({payload, integrations, next})
    addDestinationMiddleware(name, {payload, integrations, next})
}

interface SegmentUser {
    id(): string | null
    traits(): Record<string, any>
}

function _cookie(name: string): string | undefined {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift() || undefined;
}

function _session(config: Record<string, any>, storage: Storage): Session {
    let session
    // check storage for session data
    const str = storage.getItem(config.session_data_key || "session_data")
    // if result is not empty, parse json
    if (str && str != "") {
        session = JSON.parse(str);
    }

    const now = Date.now()
    // if session is undefined or expired, generate new session
    if (!session || (now - session.expires) <= 0) {
        session = {}
        session.id = now.toString() + '.' + (Math.random() + 1).toString(36).substring(6);
        session.start = now;
        session.data = {
            landing_page: document.location.href,
            referrer: document.referrer,
            // loop through specified query params to collect utms
            campaign: function (keys: Array<string>): undefined | Record<string, string | undefined> {
                if (keys.length == 0 || document.location.search == "") return undefined;
                const query = new URLSearchParams(document.location.search);
                if (!query) return undefined;
                let out = {};
                let s = "";
                for (const i in keys) {
                    s = query.get(keys[i]);
                    if (!s || s == "") continue;
                    out[keys[i]] = s;
                }
                return out;
            }(config.url_params || [])
        }
    }

    // update session expiration time
    session.expires = now + ((config.session_duration || 30) * 60);

    // return session
    return <Session>session
}

function _context(config: Record<string, () => any>, session: Session): Context {
    let context: Partial<Context> = {}
    context.session = session
    // set properties defined in context config
    for (const prop in config) {
        context[prop] = config[prop]()
    }
    return <Context>context
}

function _integrations(config: Record<string, () => Record<string, any>>): Record<string, Record<string, any>> {
    let out = {}
    for (const integration in config) {
        out[integration] = config[integration]()
    }
    return out
}

function _enrich(context: Context, payload: Record<string, any>): void {
    // check and update user
    if (!context.user) {
        const analytics = window["analytics"]
        context.user = analytics.user()
    }

    // set properties from context
    payload.obj.context.traits = context.user.traits()
    payload.obj.context.active = context.user.id() != null
    payload.obj.context.location = context.location
    payload.obj.context.screen = context.screen
    payload.obj.context.page = { ...context.page, ...payload.obj.context.page }
    payload.obj.context.timezone = context.timezone
    payload.obj.context.session_id = context.session.id
    payload.obj.context.campaign = context.session.data.campaign
}


let _analytics_session = _session(_analytics_session_config, localStorage)
let _analytics_context = _context(_analytics_context_config, _analytics_session)

function _register(analytics: SegmentAnalytics) {
    //@ts-ignore
    analytics.addSourceMiddleware(function ({payload, integrations, next}) {
        // check and update user
        if (!_analytics_context.user) {
            const analytics = window["analytics"]
            _analytics_context.user = analytics.user()
        }

        // set page data in context
        switch (payload.obj.type) {
            case "page":
                _analytics_context.page = {
                    name: payload.obj.name? payload.obj.name : undefined,
                    category: payload.obj.category? payload.obj.category : undefined,
                    ...payload.obj.properties? payload.obj.properties : undefined
                }
        }

        // enrich with context
        _enrich(_analytics_context, payload)

        // loop through integration config and set properties
        const tmp = _integrations(_analytics_integration_config)

        // set both context.integrations and integrations, just to be safe
        payload.obj.context.integrations = {...payload.obj.context.integrations, ...tmp}
        payload.obj.integrations = {...payload.obj.context.integrations, ...tmp}
        next(payload)
    })

    //@ts-ignore
    analytics.addDestinationMiddleware( "Google Tag Manager", function ({payload, integrations, next}){
        // set context to property to pass to GTM
        payload.obj.properties.context = payload.obj.context;
        next(payload)
    })
}
