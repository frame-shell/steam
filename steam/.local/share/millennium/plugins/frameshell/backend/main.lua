--[[
  frameshell bridge, backend side. Millennium runs plugin backends in LuaJIT, which has
  no socket library of its own, so the Unix socket of the shell
  ($XDG_RUNTIME_DIR/qs-steam.sock, see quickshell/.config/quickshell/services/SteamBridge.qml)
  is opened through LuaJIT's ffi and libc. Everything is non-blocking: the frontend calls
  bridge_poll every half second, which (re)connects, reads the shell's commands and
  writes what is still pending. bridge_send queues one JSON line for the shell.
]]

local ffi = require("ffi")
local json = require("json")
local logger = require("logger")
local millennium = require("millennium")

ffi.cdef [[
struct frameshell_sockaddr_un { unsigned short sun_family; char sun_path[108]; };
int socket(int domain, int type, int protocol);
int connect(int fd, const struct frameshell_sockaddr_un *addr, unsigned int len);
long send(int fd, const char *buf, unsigned long len, int flags);
long recv(int fd, char *buf, unsigned long len, int flags);
int close(int fd);
]]

-- Linux values (the same on 32 and 64 bit)
local AF_UNIX = 1
local SOCK_STREAM = 1
local SOCK_CLOEXEC = 0x80000
local MSG_DONTWAIT = 0x40
local MSG_NOSIGNAL = 0x4000
local EAGAIN = 11
local EINTR = 4

local RETRY_SECONDS = 3
local MAX_PENDING = 256 * 1024

local socket_path = (os.getenv("XDG_RUNTIME_DIR") or "/tmp") .. "/qs-steam.sock"
local fd = -1
local inbox = ""
local outbox = ""
local last_try = 0
local read_buffer = ffi.new("char[?]", 4096)

local function disconnect()
    if fd >= 0 then
        ffi.C.close(fd)
        logger:info("frameshell: shell disconnected")
    end
    fd = -1
    inbox = ""
    outbox = ""
end

local function try_connect()
    if fd >= 0 or os.time() - last_try < RETRY_SECONDS then
        return
    end
    last_try = os.time()
    if #socket_path >= 108 then
        return
    end

    local s = ffi.C.socket(AF_UNIX, SOCK_STREAM + SOCK_CLOEXEC, 0)
    if s < 0 then
        return
    end
    local addr = ffi.new("struct frameshell_sockaddr_un")
    addr.sun_family = AF_UNIX
    ffi.copy(addr.sun_path, socket_path)
    -- A local connect answers at once: there is a listener or there is not
    if ffi.C.connect(s, addr, ffi.sizeof(addr)) ~= 0 then
        ffi.C.close(s)
        return
    end
    fd = s
    logger:info("frameshell: connected to " .. socket_path)
end

-- Writes as much of the outbox as the socket takes right now
local function flush()
    while fd >= 0 and #outbox > 0 do
        local n = tonumber(ffi.C.send(fd, outbox, #outbox, MSG_DONTWAIT + MSG_NOSIGNAL))
        if n > 0 then
            outbox = outbox:sub(n + 1)
        else
            local err = ffi.errno()
            if err ~= EAGAIN and err ~= EINTR then
                disconnect()
            end
            return
        end
    end
end

-- Reads whatever arrived and returns the complete lines
local function read_lines()
    while fd >= 0 do
        local n = tonumber(ffi.C.recv(fd, read_buffer, 4096, MSG_DONTWAIT))
        if n > 0 then
            inbox = inbox .. ffi.string(read_buffer, n)
        elseif n == 0 then
            disconnect()
        else
            local err = ffi.errno()
            if err ~= EAGAIN and err ~= EINTR then
                disconnect()
            end
            break
        end
    end

    local lines = {}
    while true do
        local newline = inbox:find("\n", 1, true)
        if not newline then
            break
        end
        local line = inbox:sub(1, newline - 1)
        inbox = inbox:sub(newline + 1)
        if line:match("%S") then
            lines[#lines + 1] = line
        end
    end
    return lines
end

-- Called by the frontend: queues one event (a JSON string) for the shell
function bridge_send(line)
    if fd < 0 or type(line) ~= "string" then
        return false
    end
    if #outbox + #line > MAX_PENDING then
        return false
    end
    outbox = outbox .. line .. "\n"
    flush()
    return fd >= 0
end

-- Called by the frontend every half second: { connected, lines = { "<json>", … } }
function bridge_poll()
    try_connect()
    flush()
    local lines = read_lines()
    return json.encode({ connected = fd >= 0, lines = #lines > 0 and lines or nil })
end

local function on_load()
    logger:info("frameshell: bridge to " .. socket_path)
    millennium.ready()
end

local function on_unload()
    disconnect()
end

return {
    on_load = on_load,
    on_unload = on_unload
}
