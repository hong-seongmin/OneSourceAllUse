export const inboxSortOptions = Object.freeze({
  published_desc: {
    label: '최신 게시순',
    orderBy: 'inbox.published_at DESC NULLS LAST, inbox.updated_at DESC, inbox.id DESC'
  },
  updated_desc: {
    label: '최근 수집순',
    orderBy: 'inbox.updated_at DESC, inbox.published_at DESC NULLS LAST, inbox.id DESC'
  },
  title_asc: {
    label: '제목순',
    orderBy: 'inbox.title ASC, inbox.published_at DESC NULLS LAST, inbox.id DESC'
  }
});

export function resolveInboxSort(value) {
  return Object.hasOwn(inboxSortOptions, value) ? value : 'published_desc';
}
