import type { ListNode, SciList } from "../memory.ts";
import type { KernelFn, SendRequest, Vm } from "../vm.ts";
import { NULL, bool, segmentOf, toSigned, type Value } from "../value.ts";

const list = (vm: Vm, v: Value): SciList => {
  const l = vm.memory.list(v);
  if (!l) throw new Error(`Not a list: ${v.toString(16)}`);
  return l;
};

function unlink(l: SciList, n: ListNode) {
  if (n.prev) n.prev.next = n.next;
  else l.first = n.next;
  if (n.next) n.next.prev = n.prev;
  else l.last = n.prev;
  n.prev = n.next = n.list = undefined;
}

function nodes(l: SciList): ListNode[] {
  const out: ListNode[] = [];
  for (let n = l.first; n; n = n.next) out.push(n);
  return out;
}

/**
 * Doubly linked lists of nodes (value + key). The system scripts' List/Set/Collection
 * classes are thin wrappers around these.
 */
export const listKernels: Record<string, KernelFn> = {
  NewList: (vm) => vm.memory.newList().address,
  // As in SSCI, disposing a list frees its nodes, and DeleteKey frees the node it removes.
  DisposeList: (vm, [l = 0]) => {
    const lst = vm.memory.list(l);
    if (!lst) return;
    for (const n of nodes(lst)) {
      n.list = undefined;
      vm.memory.free(segmentOf(n.address));
    }
    lst.first = lst.last = undefined;
    vm.memory.free(segmentOf(l));
  },
  // SCI32: key defaults to the value.
  NewNode: (vm, [value = 0, key]) => vm.memory.newNode(value, key ?? value).address,
  FirstNode: (vm, [l = 0]) => (l ? list(vm, l).first?.address ?? NULL : NULL),
  LastNode: (vm, [l = 0]) => (l ? list(vm, l).last?.address ?? NULL : NULL),
  EmptyList: (vm, [l = 0]) => bool(!l || !list(vm, l).first),
  NextNode: (vm, [n = 0]) => vm.memory.node(n)?.next?.address ?? NULL,
  PrevNode: (vm, [n = 0]) => vm.memory.node(n)?.prev?.address ?? NULL,
  NodeValue: (vm, [n = 0]) => vm.memory.node(n)?.value ?? NULL,

  AddToEnd: (vm, [l = 0, n = 0, key]) => {
    const lst = list(vm, l), node = vm.memory.node(n)!;
    if (key !== undefined) node.key = key;
    node.list = lst;
    node.prev = lst.last;
    node.next = undefined;
    if (lst.last) lst.last.next = node;
    else lst.first = node;
    lst.last = node;
    return n;
  },
  AddToFront: (vm, [l = 0, n = 0, key]) => {
    const lst = list(vm, l), node = vm.memory.node(n)!;
    if (key !== undefined) node.key = key;
    node.list = lst;
    node.next = lst.first;
    node.prev = undefined;
    if (lst.first) lst.first.prev = node;
    else lst.last = node;
    lst.first = node;
    return n;
  },
  AddAfter: (vm, [l = 0, after = 0, n = 0, key]) => {
    const lst = list(vm, l), prev = vm.memory.node(after), node = vm.memory.node(n)!;
    if (key !== undefined) node.key = key;
    if (!prev) return listKernels.AddToFront!(vm, [l, n]);
    node.list = lst;
    node.prev = prev;
    node.next = prev.next;
    if (prev.next) prev.next.prev = node;
    else lst.last = node;
    prev.next = node;
    return n;
  },
  FindKey: (vm, [l = 0, key = 0]) => nodes(list(vm, l)).find((n) => n.key === key)?.address ?? NULL,
  DeleteKey: (vm, [l = 0, key = 0]) => {
    const lst = list(vm, l);
    const n = nodes(lst).find((x) => x.key === key);
    if (!n) return 0;
    unlink(lst, n);
    vm.memory.free(segmentOf(n.address));
    return 1;
  },
  ListAt: (vm, [l = 0, index = 0]) => nodes(list(vm, l))[toSigned(index)]?.value ?? NULL,
  ListIndexOf: (vm, [l = 0, value = 0]) => nodes(list(vm, l)).findIndex((n) => n.value === value) & 0xffff,

  // Iteration kernels send `selector` (+args) to each element. They're generators so the
  // sends run on the VM's frame stack. Snapshot first so an element can remove itself.
  *ListEachElementDo(vm: Vm, [l = 0, selector = 0, ...args]: Value[]): Generator<SendRequest, Value, Value> {
    for (const n of nodes(list(vm, l))) if (n.list) yield { object: n.value, selector, args };
    return 0;
  },
  *ListFirstTrue(vm: Vm, [l = 0, selector = 0, ...args]: Value[]): Generator<SendRequest, Value, Value> {
    for (const n of nodes(list(vm, l))) if (yield { object: n.value, selector, args }) return n.value;
    return NULL;
  },
  *ListAllTrue(vm: Vm, [l = 0, selector = 0, ...args]: Value[]): Generator<SendRequest, Value, Value> {
    for (const n of nodes(list(vm, l))) if (!(yield { object: n.value, selector, args })) return 0;
    return 1;
  },
};
