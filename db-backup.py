import os, shutil, datetime
os.makedirs('backups', exist_ok=True)
# prisma db file dhoondo
candidates = ['prisma/dev.db', 'prisma/prod.db', 'dev.db']
src = None
for c in candidates:
    if os.path.exists(c):
        src = c
        break
if not src:
    print("DB file nahi mila. Checking prisma folder...")
    import glob
    files = glob.glob('**/*.db', recursive=True)
    print(files)
    exit(1)
dst = f"backups/smartmart-{datetime.datetime.now().strftime('%Y-%m-%d_%H-%M')}.db"
shutil.copy2(src, dst)
print(f"Backup created: {dst} ({os.path.getsize(dst)} bytes)")
