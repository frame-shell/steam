/*
 * frameshell bridge, frontend side. Millennium loads this into Steam's SharedJSContext,
 * where Steam's NotificationStore decides which toasts to show. While the shell is
 * connected, the notifications below go to the shell (over backend/main.lua and the
 * Unix socket) and Steam's own toast is skipped; the tray (bell) in Steam keeps them.
 * Without the shell, Steam shows its toasts as usual.
 *
 * The hook: ProcessNotification(target, notification, action) would be the place, but on
 * current Steam it is a bound, frozen own property of the store. So the store's
 * BShowToast(…notification…) on the prototype is wrapped instead: it answers "no toast"
 * for what went to the shell. Everything this file logs also lands in Steam's
 * console-linux.txt through the backend (bridge_log), prefixed "frameshell:".
 *
 * Hand-written in the shape Millennium's build tool emits (window.PLUGIN_LIST, default
 * export, backend IPC message 1), so there is no build step. Steam's internals are
 * minified and change with updates: every lookup is guarded, and a part that breaks
 * only turns forwarding off, never Steam's own toasts.
 */
(function () {
    const pluginName = "frameshell";
    const VERSION = "1.0.0";
    (window.PLUGIN_LIST ||= {})[pluginName] ||= {};

    // NotificationStore values: eSource 1 = from the client, 2 = from Steam's servers
    const CLIENT = 1;
    const SERVER = 2;
    // eType of the notifications that are forwarded (and whose toast is skipped)
    const DOWNLOAD_COMPLETE = 1;
    const FRIEND_INVITE = 2;
    const FRIEND_IN_GAME = 3;
    const FRIEND_ONLINE = 4;
    const ACHIEVEMENT = 5;
    const FRIEND_MESSAGE = 8;
    const GROUP_CHAT_MESSAGE = 9;

    let connected = false;
    let patched = false;
    const seen = new Set();

    const log = (...args) => {
        console.log("%c frameshell ", "background:#5d6fe8;color:#fff", ...args);
        try {
            backend("bridge_log", args.map(a => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")).catch(() => { });
        } catch { }
    };

    function backend(method, ...args) {
        return window.MILLENNIUM_API.ffi(pluginName, method)(...args);
    }

    function send(event) {
        if (!connected)
            return;
        backend("bridge_send", JSON.stringify(event)).catch(() => { });
        if (event.type !== "hello")
            log(`→ shell: ${event.type}${event.state ? " " + event.state : ""}${event.kind ? " " + event.kind : ""}`);
    }

    function hello() {
        send({ type: "hello", version: VERSION, suppressing: patched });
    }

    // ── Reading Steam's data ─────────────────────────────────

    // Client notifications carry protobuf messages with a getter per field
    function field(data, name) {
        try {
            const value = typeof data?.[name] === "function" ? data[name]() : data?.[name];
            return value ?? "";
        } catch {
            return "";
        }
    }

    function accountId(steamId) {
        try {
            return Number(BigInt(steamId) & 0xffffffffn);
        } catch {
            return 0;
        }
    }

    function friend(steamId) {
        try {
            const player = window.g_FriendsUIApp?.FriendStore?.GetPlayer(accountId(steamId));
            return { name: player?.display_name ?? "", avatar: player?.persona?.avatar_url_medium ?? "" };
        } catch {
            return { name: "", avatar: "" };
        }
    }

    function gameName(appId) {
        try {
            return window.appStore?.GetAppOverviewByAppID(Number(appId))?.display_name ?? "";
        } catch {
            return "";
        }
    }

    function serverBody(data) {
        try {
            const body = data?.item?.body_data;
            return typeof body === "string" ? JSON.parse(body) : body ?? {};
        } catch {
            return {};
        }
    }

    // A notification as an event for the shell, or null to leave it to Steam
    function toEvent(n) {
        const d = n.data;
        if (n.eSource === CLIENT) {
            switch (n.eType) {
            case DOWNLOAD_COMPLETE: {
                const appId = String(field(d, "appid"));
                return { type: "download", state: "done", appId, game: gameName(appId) || `app ${appId}` };
            }
            case FRIEND_IN_GAME:
            case FRIEND_ONLINE: {
                const steamId = String(field(d, "steamid"));
                const who = friend(steamId);
                return {
                    type: "friend",
                    state: n.eType === FRIEND_IN_GAME ? "ingame" : "online",
                    name: who.name || "a friend",
                    steamId,
                    avatar: who.avatar,
                    game: String(field(d, "game_name"))
                };
            }
            case ACHIEVEMENT: {
                // Progress toasts (not unlocked yet) stay with Steam
                if (!field(d, "achieved"))
                    return null;
                const appId = String(field(d, "appid"));
                return {
                    type: "achievement",
                    appId,
                    game: gameName(appId),
                    name: String(field(d, "name")),
                    description: String(field(d, "description")),
                    icon: String(field(d, "image_url"))
                };
            }
            case FRIEND_MESSAGE: {
                const steamId = String(field(d, "steamid"));
                const who = friend(steamId);
                const from = String(field(d, "title")) || who.name || "a friend";
                const avatar = String(field(d, "icon")) || who.avatar;
                // Game invites come as messages with a steam:// link to join
                const url = String(field(d, "response_steamurl"));
                if (url.startsWith("steam://"))
                    return { type: "invite", kind: "game", from, steamId, avatar, text: String(field(d, "body")), url };
                return { type: "message", from, steamId, avatar, text: String(field(d, "body")), chat: "" };
            }
            case GROUP_CHAT_MESSAGE: {
                const steamId = String(field(d, "steamid_sender"));
                const who = friend(steamId);
                return {
                    type: "message",
                    from: who.name || "someone",
                    steamId,
                    avatar: String(field(d, "icon")) || who.avatar,
                    text: String(field(d, "rawbody") || field(d, "body")),
                    chat: String(field(d, "title")) || "group chat",
                    groupId: String(field(d, "chat_group_id")),
                    chatId: String(field(d, "chat_id"))
                };
            }
            }
            return null;
        }

        if (n.eSource === SERVER && n.eType === FRIEND_INVITE) {
            // Server notifications are replayed at login; only fresh, unseen ones count
            const item = n.data?.item ?? {};
            const created = Number(n.rtCreated || item.timestamp || 0);
            if (item.viewed || item.read || Date.now() / 1000 - created > 120)
                return null;
            const body = serverBody(n.data);
            const steamId = String(body.requestor_id ?? body.requestorID ?? "");
            const who = friend(steamId);
            return { type: "invite", kind: "friend", from: who.name || "someone", steamId, avatar: who.avatar };
        }
        return null;
    }

    // ── Hooking the toasts ───────────────────────────────────

    // Replaces a method where it lives (the object itself or a prototype), if that spot allows it
    function hookMethod(store, name, wrap) {
        let owner = store;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, name))
            owner = Object.getPrototypeOf(owner);
        if (!owner)
            return false;
        const d = Object.getOwnPropertyDescriptor(owner, name);
        if (typeof d.value !== "function")
            return false;
        if (d.value.__frameshell)
            return true;
        const wrapped = wrap(d.value);
        wrapped.__frameshell = true;
        try {
            if (d.writable) owner[name] = wrapped;
            else if (d.configurable) Object.defineProperty(owner, name, { value: wrapped, writable: true, configurable: true });
            else return false;
        } catch {
            return false;
        }
        return owner[name] === wrapped;
    }

    const isNotification = x => x && typeof x === "object" && "eType" in x && "eSource" in x;

    // A notification goes to the shell once; the shell gets it, Steam keeps the tray entry
    // and skips its toast. Returns true when the toast is to be skipped.
    function forward(notification) {
        const id = notification?.notificationID;
        if (!connected || id === undefined)
            return false;
        if (seen.has(id))
            return true;
        const event = toEvent(notification);
        if (!event)
            return false;
        send(event);
        seen.add(id);
        if (seen.size > 500)
            seen.delete(seen.values().next().value);
        return true;
    }

    function patch(store) {
        if (!store)
            return false;
        // Steam's ProcessNotification(target, notification, action) decides tray and toast.
        // On current Steam it is a bound, frozen own property, so the second choice is
        // BShowToast(…notification…) on the prototype, which only answers "toast or not".
        if (hookMethod(store, "ProcessNotification", original => function (target, notification, action) {
            let skip = false;
            try { skip = forward(notification); } catch (e) { log("could not read a notification", e); }
            if (skip)
                target = Object.assign({}, target, { showToast: false });
            return original.call(this, target, notification, action);
        })) {
            log("hooked ProcessNotification");
            return true;
        }
        if (hookMethod(store, "BShowToast", original => function (...args) {
            try {
                const notification = args.find(isNotification);
                if (notification && forward(notification))
                    return false;
            } catch (e) {
                log("could not read a notification", e);
            }
            return original.apply(this, args);
        })) {
            log("hooked BShowToast");
            return true;
        }
        return false;
    }

    // What the store offers, for the log: own fields with their descriptors, the prototype's
    // methods and the source of ProcessNotification (only when hooking it failed)
    function inspectStore() {
        try {
            const store = window.NotificationStore;
            if (!store) { log("NotificationStore: not there"); return; }
            const own = Object.getOwnPropertyNames(store).map(k => {
                const d = Object.getOwnPropertyDescriptor(store, k);
                const t = typeof d.value;
                return `${k}:${d.get ? "getter" : t}${d.writable ? "" : "!w"}${d.configurable ? "" : "!c"}`;
            });
            for (let i = 0; i < own.length; i += 12)
                log(`store own ${i}: ${own.slice(i, i + 12).join(" ")}`);
            let proto = Object.getPrototypeOf(store), depth = 0;
            while (proto && proto !== Object.prototype && depth < 3) {
                const names = Object.getOwnPropertyNames(proto);
                for (let i = 0; i < names.length; i += 15)
                    log(`store proto${depth} ${i}: ${names.slice(i, i + 15).join(" ")}`);
                proto = Object.getPrototypeOf(proto); depth++;
            }
            const src = String(store.ProcessNotification);
            for (let i = 0; i < Math.min(src.length, 2400); i += 380)
                log(`ProcessNotification src ${i}: ${src.slice(i, i + 380)}`);
        } catch (e) {
            log("inspect failed", e);
        }
    }

    // The store is created after login; look for it until it is there
    function waitForStore(tries = 0) {
        try {
            if (patch(window.NotificationStore)) {
                patched = true;
                log("forwarding notifications to the shell");
                hello();
                return;
            }
        } catch (e) {
            if (tries === 0)
                log("could not hook NotificationStore", e);
        }
        if (tries === 20)
            inspectStore();
        if (tries === 60)
            log("NotificationStore not found yet, Steam's toasts stay on");
        setTimeout(() => waitForStore(tries + 1), tries < 60 ? 1000 : 10000);
    }

    // ── Commands from the shell ──────────────────────────────

    const digits = value => /^\d+$/.test(String(value ?? ""));

    function steamUrl(url) {
        window.SteamClient?.URL?.ExecuteSteamURL(url);
    }

    // The same messages Steam's library sends its friends UI
    function libraryCommand(command, args) {
        window.SteamClient?.Messaging?.PostMessage("LibraryCommands", command, JSON.stringify(args));
    }

    function run(command) {
        switch (command.cmd) {
        case "open_chat":
            if (digits(command.steamId))
                libraryCommand("ShowFriendChatDialog", { steamid: String(command.steamId), btakefocus: 1 });
            break;
        case "open_group":
            if (digits(command.groupId))
                libraryCommand("ShowChatRoomGroupDialog", {
                    chat_group_id: String(command.groupId),
                    chat_room_id: digits(command.chatId) ? String(command.chatId) : "0"
                });
            break;
        case "accept_invite":
            if (typeof command.url === "string" && command.url.startsWith("steam://"))
                steamUrl(command.url);
            break;
        case "play":
            if (digits(command.appId))
                steamUrl(`steam://rungameid/${command.appId}`);
            break;
        case "open_downloads":
            steamUrl("steam://open/downloads");
            break;
        case "show_friends":
            libraryCommand("ShowPopupFriendsList", {});
            break;
        case "show":
            steamUrl("steam://open/main");
            break;
        default:
            log("unknown command", command.cmd);
        }
    }

    // Twice a second: (re)connect, take the shell's commands, write what is pending
    async function poll() {
        try {
            const raw = await backend("bridge_poll");
            const state = typeof raw === "string" ? JSON.parse(raw) : raw;
            const was = connected;
            connected = state?.connected === true;
            if (connected && !was) {
                log("shell connected");
                hello();
            }
            for (const line of Array.isArray(state?.lines) ? state.lines : []) {
                try {
                    run(JSON.parse(line));
                } catch (e) {
                    log("bad command", line, e);
                }
            }
        } catch (e) {
            connected = false;
        }
        setTimeout(poll, 500);
    }

    async function main() {
        if (!window.MILLENNIUM_API?.ffi) {
            log("Millennium API missing, bridge off");
            return;
        }
        poll();
        waitForStore();
    }

    Object.assign(window.PLUGIN_LIST[pluginName], {
        default: main,
        __millennium_internal_plugin_name_do_not_use_or_change__: pluginName
    });

    (async () => {
        try {
            await window.MILLENNIUM_BACKEND_IPC?.postMessage(1, { pluginName });
        } catch (e) {
            console.log("frameshell: frontend-loaded message failed", e);
        }
        try {
            await main();
            log("frontend up");
        } catch (e) {
            log("frontend failed", e);
        }
    })();
})();
