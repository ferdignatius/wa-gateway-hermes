const queues = new Map<string, Promise<void>>();

export function enqueue(chatId: string, task: () => Promise<void>) {
    const current = queues.get(chatId) || Promise.resolve();

    const next = current
        .then(task)
        .catch((err) => {
            console.error(`[Queue] error processing ${chatId}:`, err);
        })
        .finally(() => {
            // Hapus dari map jika promise ini adalah yang terakhir untuk chatId ini (mencegah memory leak)
            if (queues.get(chatId) === next) {
                queues.delete(chatId);
            }
        });

    queues.set(chatId, next);
}