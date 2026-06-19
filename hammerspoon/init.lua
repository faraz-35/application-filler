 -- Interview Helper — global hotkey to AI-fill the focused form field.
--
-- Workflow: copy a question -> press a hotkey -> a spinner follows your cursor
-- while the AI thinks, then the answer is pasted into whatever field has focus
-- (and left on the clipboard).
--
-- Profiles: each hotkey runs src/answer.mjs with a profile name, which loads
-- its own context from contexts/<profile>/. Add a new profile = mkdir + bind.
--
-- Bound to:
--   Cmd + Alt + J   -> "interview" profile  (blue spinner)
--   Cmd + Alt + P   -> "parhako"   profile  (purple spinner)

local projectDir = "/Users/farazshah/Programming/interview-helper"
local logPath = projectDir .. "/hammerspoon/run.log"

local function logf(msg)
  local f = io.open(logPath, "a")
  if f then
    f:write(os.date("%H:%M:%S") .. "  " .. tostring(msg) .. "\n")
    f:close()
  end
end

-- Works across Hammerspoon versions (getAbsolutePosition was renamed).
local function mousePos()
  if hs.mouse.absolutePosition then return hs.mouse.absolutePosition() end
  return hs.mouse.getAbsolutePosition()
end

-- ---------- Loading cursor (follows the mouse) ----------
local loader = { canvas = nil, tracker = nil, anim = nil, angle = 0 }

local function loaderFollow()
  if loader.canvas then
    local p = mousePos()
    loader.canvas:topLeft({ x = p.x + 12, y = p.y + 12 })
  end
end

local function stopLoader()
  if loader.anim then loader.anim:stop(); loader.anim = nil end
  if loader.tracker then loader.tracker:stop(); loader.tracker = nil end
  if loader.canvas then loader.canvas:delete(); loader.canvas = nil end
end

-- Spinning 3/4 arc that sticks to the cursor. color = hex string.
local function startLoader(color)
  stopLoader()
  loader.canvas = hs.canvas.new({ x = 0, y = 0, w = 26, h = 26 })
  loader.canvas[1] = {
    type = "arc",
    radius = 10,
    startAngle = 0,
    endAngle = 270,
    action = "stroke",
    strokeWidth = 3,
    strokeColor = { hex = color, alpha = 1 },
  }
  loader.canvas:level("status")
  loader.canvas:show()
  loaderFollow()

  loader.tracker = hs.eventtap.new({ hs.eventtap.event.types.mouseMoved }, loaderFollow)
  loader.tracker:start()

  loader.angle = 0
  loader.anim = hs.timer.doEvery(0.03, function()
    loader.angle = (loader.angle + 12) % 360
    if loader.canvas then
      loader.canvas:elementAttribute(1, "startAngle", loader.angle)
      loader.canvas:elementAttribute(1, "endAngle", loader.angle + 270)
    end
  end)
end

-- Brief solid dot (red = error) at the cursor, then disappears.
local function flashDot(color)
  stopLoader()
  loader.canvas = hs.canvas.new({ x = 0, y = 0, w = 22, h = 22 })
  loader.canvas[1] = { type = "oval", action = "fill", fillColor = { hex = color, alpha = 1 } }
  loader.canvas:level("status")
  loader.canvas:show()
  loaderFollow()
  hs.timer.doAfter(1.0, stopLoader)
end

-- ---------- Locate node ----------
local nodeBin = nil
for _, path in ipairs({ "/opt/homebrew/bin/node", "/usr/local/bin/node" }) do
  if hs.fs.attributes(path) then nodeBin = path break end
end
if not nodeBin then
  local found = hs.execute("/bin/sh -lc 'command -v node'")
  nodeBin = found and found:match("^%s*(%S+)")
end

-- ---------- Main flow ----------
-- profile = contexts/<profile> dir to load; color = spinner hex.
local function runProfile(profile, color)
  logf("=== hotkey pressed (profile=" .. profile .. ") ===")
  if not nodeBin then
    logf("node not found")
    flashDot("#EF4444")
    return
  end

  startLoader(color)  -- spinner while GLM thinks

  local task = hs.task.new(nodeBin, function(exitCode, stdOut, stdErr)
    logf("exitCode=" .. tostring(exitCode) .. " err=" .. (stdErr or ""):sub(1, 120))
    if exitCode ~= 0 then
      flashDot("#EF4444")  -- red = something failed
      return
    end
    -- Answer is on the clipboard. Paste into the focused field.
    hs.timer.doAfter(0.15, function()
      local ok, err = pcall(function() hs.eventtap.keyStroke({ "cmd" }, "v") end)
      stopLoader()
      if not ok then
        logf("paste failed: " .. tostring(err))
        flashDot("#EF4444")
      end
    end)
  end, { "--env-file=.env", "src/answer.mjs", profile })

  task:setWorkingDirectory(projectDir)
  task:start()
end

hs.hotkey.bind({ "cmd", "alt" }, "j", function() runProfile("interview", "#3B82F6") end)  -- blue
hs.hotkey.bind({ "cmd", "alt" }, "p", function() runProfile("parhako", "#A855F7") end)    -- purple
logf("LOADED config — node=" .. tostring(nodeBin))
