#!/usr/bin/env python3
"""What the chats sent, by effort, from Claude Code's own transcripts: the trial record of docs/fork/install.md.

Every request Claude Code sends is kept in ~/.claude/projects/<project>/<session>.jsonl as an `api-request` row
(params.model, params.output_config.effort), and its answer's usage on the `assistant` rows whose requestRef is that
row's id. Subagents are in <session>/subagents/*.jsonl. Nothing here needs effortless: run it on the week before the
install too, for a baseline.

  python3 tools/effort-trial.py --since 2026-11-16 --until 2026-11-23
  python3 tools/effort-trial.py --self-test
"""
import argparse
import collections
import json
import os
import sys
import tempfile

# Cost of one token relative to an uncached input token, as effortless weighs it (hooks/register.tsx WEIGHT).
WEIGHT = {'input_tokens': 1, 'cache_creation_input_tokens': 1.25, 'cache_read_input_tokens': 0.1, 'output_tokens': 5}


def scan(root, since, until):
    """Totals per (who, model, effort): requests, tokens by kind, weighted cost; and the main chats' typed prompts."""
    rows = collections.defaultdict(lambda: collections.Counter())
    prompts = collections.Counter()
    for folder, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith('.jsonl'):
                continue
            who = 'subagent' if os.sep + 'subagents' in folder else 'main'
            sent, usage, turns = {}, {}, []
            with open(os.path.join(folder, name), encoding='utf-8', errors='replace') as f:
                for line in f:
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    day = str(d.get('timestamp', ''))[:10]
                    if d.get('type') == 'api-request' and since <= day <= until:
                        p = d.get('params') or {}
                        sent[d.get('id')] = (p.get('model', '?'), (p.get('output_config') or {}).get('effort') or 'none')
                        if turns:
                            turns[-1].append(sent[d.get('id')][1])
                    elif d.get('type') == 'assistant' and d.get('requestRef'):
                        usage.setdefault(d['requestRef'], (d.get('message') or {}).get('usage') or {})
                    elif (who == 'main' and d.get('type') == 'user' and since <= day <= until
                          and (d.get('origin') or {}).get('kind') == 'human'):
                        # typed: at the prompt between turns; queued: typed while a turn ran.
                        prompts[d.get('promptSource') or 'typed'] += 1
                        if d.get('promptSource') != 'queued':
                            turns.append([])
            # A turn whose later requests went out at another effort than its first: effortless's pick did not hold.
            prompts['turns'] += sum(1 for t in turns if len(t) > 1)
            prompts['changed'] += sum(1 for t in turns if len(set(t)) > 1)
            for ref, (model, effort) in sent.items():
                c = rows[(who, model, effort)]
                c['requests'] += 1
                u = usage.get(ref, {})
                for kind, w in WEIGHT.items():
                    n = u.get(kind) or 0
                    c[kind] += n
                    c['cost'] += n * w
    return rows, prompts


def report(rows, prompts):
    out = [f"prompts a person typed: {prompts['typed']} between turns, {prompts['queued']} while a turn ran",
           f"turns of 2+ requests: {prompts['turns']}, of them sent at more than one effort: {prompts['changed']}", '',
           'who       model                effort  requests      output  cache read  cache write    weighted']
    for (who, model, effort), c in sorted(rows.items()):
        out.append(f"{who:9} {model:20} {effort:7} {c['requests']:8} {c['output_tokens']:11} {c['cache_read_input_tokens']:11}"
                   f" {c['cache_creation_input_tokens']:12} {c['cost']:11.0f}")
    total = sum(c['cost'] for c in rows.values())
    n = prompts['typed'] + prompts['queued']
    out += ['', f'weighted cost in all: {total:.0f}' + (f', per typed prompt: {total / n:.0f}' if n else '')]
    return '\n'.join(out)


def self_test():
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, 'p', 's1', 'subagents'))
        main = [
            {'type': 'user', 'timestamp': '2026-11-16T01:00:00Z', 'origin': {'kind': 'human'}, 'promptSource': 'typed', 'message': {'content': 'fix the test'}},
            {'type': 'user', 'timestamp': '2026-11-16T01:00:01Z', 'origin': {'kind': 'human'}, 'promptSource': 'queued', 'message': {'content': 'thanks'}},
            {'type': 'user', 'timestamp': '2026-11-16T01:00:01Z', 'origin': {'kind': 'task-notification'}, 'message': {'content': '<task-notification>'}},
            {'type': 'user', 'timestamp': '2026-11-16T01:00:01Z', 'message': {'content': [{'type': 'tool_result'}]}},
            {'type': 'api-request', 'id': 'r1', 'timestamp': '2026-11-16T01:00:02Z', 'params': {'model': 'claude-opus-5-5', 'output_config': {'effort': 'low'}}},
            {'type': 'assistant', 'requestRef': 'r1', 'message': {'usage': {'output_tokens': 10, 'cache_read_input_tokens': 100}}},
            {'type': 'assistant', 'requestRef': 'r1', 'message': {'usage': {'output_tokens': 10, 'cache_read_input_tokens': 100}}},
            {'type': 'api-request', 'id': 'r2', 'timestamp': '2026-11-16T01:00:04Z', 'params': {'model': 'claude-opus-5-5', 'output_config': {'effort': 'high'}}},
            {'type': 'api-request', 'id': 'r0', 'timestamp': '2026-11-10T01:00:02Z', 'params': {'model': 'claude-opus-5-5', 'output_config': {'effort': 'max'}}},
        ]
        sub = [{'type': 'api-request', 'id': 'a1', 'timestamp': '2026-11-16T01:00:03Z', 'params': {'model': 'claude-haiku-5-5'}}]
        for path, lines in ((os.path.join(root, 'p', 's1.jsonl'), main), (os.path.join(root, 'p', 's1', 'subagents', 'a.jsonl'), sub)):
            with open(path, 'w') as f:
                f.write('\n'.join(json.dumps(x) for x in lines) + '\nnot json\n')
        rows, prompts = scan(root, '2026-11-16', '2026-11-16')
        assert prompts == {'typed': 1, 'queued': 1, 'turns': 1, 'changed': 1}, prompts
        assert set(rows) == {('main', 'claude-opus-5-5', 'low'), ('main', 'claude-opus-5-5', 'high'), ('subagent', 'claude-haiku-5-5', 'none')}, rows
        low = rows[('main', 'claude-opus-5-5', 'low')]
        assert (low['requests'], low['output_tokens'], low['cost']) == (1, 10, 60), low
    print('self-test ok')


if __name__ == '__main__':
    a = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    a.add_argument('--since', help='first day, YYYY-MM-DD (UTC)')
    a.add_argument('--until', help='last day, YYYY-MM-DD (UTC); default: the first day')
    a.add_argument('--root', default=os.path.expanduser('~/.claude/projects'))
    a.add_argument('--self-test', action='store_true')
    o = a.parse_args()
    if o.self_test:
        self_test()
        sys.exit(0)
    if not o.since:
        a.error('--since is required')
    print(report(*scan(o.root, o.since, o.until or o.since)))
