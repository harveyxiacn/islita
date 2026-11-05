<!--
  Shared read-only mail header list for the local-folder and cloud panels.
  It never renders message bodies; both callers only pass subject/from/date.
-->
<script lang="ts">
  import { formatAgo } from '$lib/format';
  import { t } from '$lib/i18n/i18n.svelte';
  import type { MailMessage } from '$lib/types';

  let {
    messages,
    now,
    empty,
  }: { messages: MailMessage[]; now: number; empty: string } = $props();
</script>

{#if messages.length === 0}
  <p class="empty">{empty}</p>
{:else}
  <ul class="messages">
    {#each messages as message (message.id)}
      <li class:unread={message.unread}>
        <span class="state" aria-hidden="true"></span>
        <span class="body">
          <span class="subject" title={message.subject}>{message.subject || t('plugin.mail.untitled')}</span>
          <span class="meta">
            <span class="from" title={message.from}>{message.from || t('plugin.mail.unknownSender')}</span>
            <span aria-hidden="true">·</span>
            <span>{formatAgo(new Date(message.dateMs).toISOString(), now)}</span>
          </span>
        </span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .messages {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .messages li {
    display: flex;
    align-items: flex-start;
    gap: 0.375rem;
    padding: 0.3rem 0.125rem;
    border-top: 1px solid var(--border);
    animation: mail-row-in 220ms var(--ease-out) both;
  }

  .state {
    flex: none;
    width: 0.3125rem;
    height: 0.3125rem;
    margin-top: 0.3rem;
    border-radius: 999px;
    background: transparent;
  }

  .messages li.unread .state {
    background: var(--focus);
  }

  .body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
  }

  .subject {
    overflow: hidden;
    font-size: 0.7188rem;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }

  .messages li.unread .subject {
    font-weight: 600;
    color: var(--text);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    overflow: hidden;
    font-size: 0.5938rem;
    color: var(--faint);
    white-space: nowrap;
  }

  .from {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .empty {
    margin: 0;
    padding: 0.5rem 0;
    font-size: 0.6875rem;
    color: var(--muted);
  }

  @keyframes mail-row-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .messages li {
      animation: none;
    }
  }
</style>
