export ENGRAM_HOME=${1:-$(mktemp -d)} ENGRAM_EMBED=off ENGRAM_PORT=1 ENGRAM_LLM=none
rm -rf $ENGRAM_HOME; mkdir -p $ENGRAM_HOME
B="$(cd "$(dirname "$0")/.." && pwd)/bin/engram.js"
node $B stats >/dev/null
start=$(date +%s)
for p in $(seq 1 8); do
  ( for i in $(seq 1 25); do
      node $B add "Process $p fact number $i about topic $((p*1000+i)) with unique token zq$p$i" --kind fact >/dev/null || echo "ADD FAIL $p $i"
      echo "{\"session_id\":\"s$p\",\"cwd\":\"/tmp\",\"prompt\":\"turn $i from process $p about topic $((p*1000+i))\"}" | node $B hook claude-code UserPromptSubmit >/dev/null || echo "HOOK FAIL"
    done ) &
done
wait
echo "elapsed $(( $(date +%s) - start ))s"
node $B stats
sqlite3 $ENGRAM_HOME/engram.db "pragma integrity_check; select count(*) from memories; select count(*) from turns; select count(*) from memories_fts; select count(*) from ops;"
ls $ENGRAM_HOME/spool 2>/dev/null | head
