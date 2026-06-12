<script lang="ts">
	import { cn } from './cn';
	let { class: className } = $props();
	const block = cn('flex h-9 h-8 items-center', className);
</script>

<button class="px-4 px-2 text-sm">one</button>
<button class={block}>two</button>
<button class="rounded-md border">clean</button>
