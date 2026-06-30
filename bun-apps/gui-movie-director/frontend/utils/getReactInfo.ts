// Walk React 19 Fiber tree from a DOM element to find owning component

export interface ReactInfo {
  componentName: string | null;
  componentStack: string[];
}

let cachedFiberKey: string | null = null;

function findFiberKey(el: Element): string | null {
  if (cachedFiberKey) {
    return (el as any)[cachedFiberKey] ? cachedFiberKey : null;
  }
  // React 19 uses __reactFiber$<random> as the key
  for (const key of Object.keys(el)) {
    if (key.startsWith("__reactFiber$")) {
      cachedFiberKey = key;
      return key;
    }
  }
  return null;
}

function getComponentName(fiber: any): string | null {
  if (!fiber || !fiber.type) return null;
  const t = fiber.type;
  if (typeof t === "function") {
    return t.displayName || t.name || null;
  }
  return null;
}

export function getReactInfo(el: Element): ReactInfo {
  const key = findFiberKey(el);
  if (!key) return { componentName: null, componentStack: [] };

  const fiber = (el as any)[key];
  if (!fiber) return { componentName: null, componentStack: [] };

  const stack: string[] = [];
  let current = fiber;
  let directComponent: string | null = null;

  // Walk up the fiber tree
  while (current) {
    // tag 0 = FunctionComponent, 1 = ClassComponent
    if (current.tag === 0 || current.tag === 1) {
      const name = getComponentName(current);
      if (name) {
        if (!directComponent) directComponent = name;
        stack.push(name);
      }
    }
    // tag 3 = HostRoot, stop here
    if (current.tag === 3) break;
    current = current.return;
  }

  return {
    componentName: directComponent,
    componentStack: stack,
  };
}
