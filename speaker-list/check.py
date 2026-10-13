import subprocess, time, json, urllib.request, os, socket, atexit
from playwright.sync_api import sync_playwright
_s=socket.socket(); _s.bind(("127.0.0.1",0)); PORT=str(_s.getsockname()[1]); _s.close()
env = dict(os.environ, PORT=PORT, ADMIN_PIN="2468")
srv = subprocess.Popen(["node","server.js"], cwd="/home/claude/glee", env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
atexit.register(lambda: srv.kill())
time.sleep(1)
B="http://127.0.0.1:"+PORT
def act(d):
    r=urllib.request.Request(B+"/action", data=json.dumps(d).encode(),
        headers={"Content-Type":"application/json"})
    return json.loads(urllib.request.urlopen(r).read())
toks={n:act({"action":"join","name":n}) for n in
      ["Owen Marshall","Jamie Chen","Desmond Okafor","Ravi Patel"]}
act({"action":"start","pin":"2468"})
time.sleep(2)
st=json.loads(urllib.request.urlopen(B+"/state").read())
active=st["active"]["id"]
for n,t in toks.items():
    if t["id"]!=active:
        act({"action":"requestRebuttal","token":t["token"]}); break

fails=[]
def ok(c,m):
    print(("  ok   " if c else "  FAIL ")+m)
    if not c: fails.append(m)

with sync_playwright() as p:
    br=p.chromium.launch()
    pg=br.new_page(viewport={"width":1600,"height":900})
    errs=[]
    pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(B+"/admin.html"); pg.wait_for_timeout(1200)
    pg.fill("#pin","2468")

    ok(not pg.is_visible("#drawer.open"), "drawer starts closed (projector stays clean)")
    pg.click("#btnRoster"); pg.wait_for_timeout(600)
    ok(pg.is_visible("#drawer.open"), "drawer opens")

    rows = pg.query_selector_all(".r-row")
    ok(len(rows)==4, f"one row per member (got {len(rows)})")
    names = [r.query_selector(".r-name").inner_text() for r in rows]
    ok("Owen Marshall" in names, "names rendered: "+", ".join(names))

    tags = [t.inner_text() for t in pg.query_selector_all(".r-tag") if t.is_visible()]
    up=[t.upper() for t in tags]
    ok("ON FLOOR" in up and "REBUTTAL" in up, "status tags shown: "+", ".join(tags))

    # find a row that is NOT on the floor so the value is stable
    target=None
    for r in rows:
        tag=r.query_selector(".r-tag")
        if not tag.is_visible() or tag.inner_text().upper()!="ON FLOOR":
            target=r; break
    inp = target.query_selector('.r-line[data-f="speakMs"] input')
    ok(inp.input_value()=="1:00", f"starts at 1:00 (got {inp.input_value()})")

    target.query_selector('.r-line[data-f="speakMs"] button[data-d="-15"]').click()
    pg.wait_for_timeout(500)
    ok(inp.input_value()=="0:45", f"minus 15 -> 0:45 (got {inp.input_value()})")

    target.query_selector('.r-line[data-f="speakMs"] button[data-d="15"]').click()
    pg.wait_for_timeout(500)
    ok(inp.input_value()=="1:00", f"plus 15 back to 1:00 (got {inp.input_value()})")

    inp.click(); inp.fill("0:07"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    ok(inp.input_value()=="0:07", f"typed value committed (got {inp.input_value()})")

    inp.click(); inp.fill("90"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    ok(inp.input_value()=="1:30", f"bare seconds parsed (got {inp.input_value()})")

    target.query_selector('.r-line[data-f="speakMs"] .full').click(); pg.wait_for_timeout(500)
    ok(inp.input_value()=="1:00", f"full minute button (got {inp.input_value()})")

    # typing must not be clobbered by incoming broadcasts
    inp.click(); inp.fill("0:33"); pg.wait_for_timeout(1400)
    ok(inp.input_value()=="0:33", f"mid-edit value survives live updates (got {inp.input_value()})")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    ok(pg.is_visible("#drawer.open"), "escape in a field does not close the drawer")
    ok(inp.input_value()=="1:00", f"escape reverts the edit (got {inp.input_value()})")

    # the person on the floor can be adjusted mid-turn
    floor_row=None
    for r in pg.query_selector_all(".r-row"):
        t=r.query_selector(".r-tag")
        if t.is_visible() and t.inner_text().upper()=="ON FLOOR": floor_row=r; break
    finp=floor_row.query_selector('.r-line[data-f="speakMs"] input')
    before=finp.input_value()
    floor_row.query_selector('.r-line[data-f="speakMs"] .full').click(); pg.wait_for_timeout(400)
    after=finp.input_value()
    ok(after in ("1:00","0:59"), f"on-floor clock reset to a full minute (was {before}, now {after})")
    pg.wait_for_timeout(1200)
    ok(finp.input_value() < after or finp.input_value()=="0:58",
       f"and keeps draining from there (now {finp.input_value()})")

    pg.on("dialog", lambda d: d.accept())
    n_before=len(pg.query_selector_all(".r-row"))
    target.query_selector(".r-x").click(); pg.wait_for_timeout(700)
    ok(len(pg.query_selector_all(".r-row"))==n_before-1, "remove drops the row")

    pg.click("#scrim"); pg.wait_for_timeout(500)
    ok(not pg.is_visible("#drawer.open"), "clicking outside closes the drawer")

    # a chair who forgets the PIN must be told, not silently ignored
    pg2=br.new_page(viewport={"width":1400,"height":900})
    pg2.goto(B+"/admin.html"); pg2.wait_for_timeout(900)
    pg2.click("#btnRoster"); pg2.wait_for_timeout(500)
    ok(pg2.is_visible("#drawerErr.show"), "missing PIN is called out on opening the drawer")
    row2=pg2.query_selector_all(".r-row")[0]
    row2.query_selector('.r-line[data-f="speakMs"] button[data-d="-15"]').click()
    pg2.wait_for_timeout(500)
    ok("PIN" in pg2.inner_text("#drawerErr"), "a rejected edit says why: "+pg2.inner_text("#drawerErr"))
    pg2.fill("#pin2","2468"); pg2.wait_for_timeout(200)
    ok(pg2.eval_on_selector("#pin","e=>e.value")=="2468", "PIN typed in the drawer reaches the footer field")
    row2.query_selector('.r-line[data-f="speakMs"] button[data-d="-15"]').click()
    pg2.wait_for_timeout(500)
    ok(not pg2.is_visible("#drawerErr.show"), "and the edit goes through once the PIN is in")

    ok(not errs, "no console errors"+("" if not errs else ": "+"; ".join(errs[:3])))
    br.close()
pass
print("\nAll good.\n" if not fails else f"\n{len(fails)} FAILED\n")
