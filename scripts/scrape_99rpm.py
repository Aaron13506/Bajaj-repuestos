"""
Crawler BFS del catálogo de diagramas Bajaj de 99rpm (dataset para el removedor
de marca). Sigue links /bajaj/*.html (sin query) y DESCARGA cada diagrama
full-size a medida que lo encuentra (las fotos aparecen enseguida). Dedup + reanuda.

Uso: python scripts/scrape_99rpm.py
Salida: data/99rpm/raw/
"""
import os, re, time, threading, queue
from concurrent.futures import ThreadPoolExecutor
import requests

BASE = "https://www.99rpm.com"
OUT = os.path.join("data", "99rpm", "raw")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
SEED = f"{BASE}/bajaj/parts.html"
CRAWL_WORKERS, DL_WORKERS, MAX_PAGES = 6, 8, 12000

LINK_RE = re.compile(r'https://www\.99rpm\.com/bajaj/[a-z0-9][a-z0-9._/-]*?\.html')
IMG_RE = re.compile(r'cache/\d+/(?:small_image|image)/[^"\']*?/([a-z0-9]/[a-z0-9]/[^"\']+?\.jpg)')

os.makedirs(OUT, exist_ok=True)
sess = requests.Session(); sess.headers.update(HEADERS)
seen_pages, seen_imgs = set(), set()
plock, ilock, dlock = threading.Lock(), threading.Lock(), threading.Lock()
counts = {"pages": 0, "ok": 0, "fail": 0}
dl_pool = ThreadPoolExecutor(max_workers=DL_WORKERS)


def get(url, tries=3):
    for _ in range(tries):
        try:
            r = sess.get(url, timeout=30)
            if r.status_code == 200:
                return r
        except Exception:
            pass
        time.sleep(1)
    return None


def download(path):
    dst = os.path.join(OUT, os.path.basename(path))
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return
    r = get(f"{BASE}/media/catalog/product/{path}")
    with dlock:
        if r and r.content[:2] == b"\xff\xd8":
            with open(dst, "wb") as f:
                f.write(r.content)
            counts["ok"] += 1
        else:
            counts["fail"] += 1
        if (counts["ok"] + counts["fail"]) % 100 == 0:
            print(f"  bajadas={counts['ok']} fallidas={counts['fail']} "
                  f"· páginas={counts['pages']} · en_disco={len(os.listdir(OUT))}", flush=True)


def worker(q):
    while True:
        try:
            url = q.get(timeout=15)
        except queue.Empty:
            return
        r = get(url)
        if r:
            for ip in IMG_RE.findall(r.text):        # descarga inmediata de nuevas
                with ilock:
                    new = ip not in seen_imgs
                    if new: seen_imgs.add(ip)
                if new:
                    dl_pool.submit(download, ip)
            for ln in LINK_RE.findall(r.text):        # sigue crawleando
                with plock:
                    if ln not in seen_pages and len(seen_pages) < MAX_PAGES:
                        seen_pages.add(ln); q.put(ln)
            with plock:
                counts["pages"] += 1
        time.sleep(0.1)
        q.task_done()


def main():
    print("Crawleando + descargando (las fotos van apareciendo en data/99rpm/raw/)...", flush=True)
    q = queue.Queue()
    q.put(SEED); seen_pages.add(SEED)
    ts = [threading.Thread(target=worker, args=(q,), daemon=True) for _ in range(CRAWL_WORKERS)]
    for t in ts: t.start()
    for t in ts: t.join()
    dl_pool.shutdown(wait=True)
    print(f"\nLISTO. imágenes_únicas={len(seen_imgs)} bajadas={counts['ok']} "
          f"fallidas={counts['fail']} en_disco={len(os.listdir(OUT))}", flush=True)


if __name__ == "__main__":
    main()