(() => {
  const csrf = document.body.dataset.csrf;
  const flash = document.querySelector('#flash');
  const tell = (message, type = 'info') => {
    if (!flash) return;
    const notice = document.createElement('div');
    notice.className = `notice ${type}`;
    notice.textContent = message;
    flash.replaceChildren(notice);
    flash.focus?.();
  };
  const requestKey = () => {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(bytes);
      return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  };
  const formValues = async (form) => {
    const result = {};
    for (const [key, value] of new FormData(form).entries()) {
      if (value instanceof File) {
        if (!value.size) continue;
        if (key !== 'transcriptFile') throw new Error('지원하지 않는 파일 입력입니다.');
        if (value.size > 750_000) throw new Error('전사 파일은 750KB 이하여야 합니다.');
        result.body = await value.text();
        result.filename = value.name;
        continue;
      }
      if (Object.hasOwn(result, key)) result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
      else result[key] = value;
    }
    if (!result.body && result.transcriptText) result.body = result.transcriptText;
    delete result.transcriptText;
    return result;
  };
  const planner = document.querySelector('.planner-form[data-planner-source-item]');
  if (planner) {
    const suggestionButton = planner.querySelector('[data-planner-suggest]');
    const suggestionPanel = planner.querySelector('[data-planner-suggestion-panel]');
    const suggestionStatus = planner.querySelector('[data-planner-suggestion-status]');
    const suggestionSources = planner.querySelector('[data-planner-suggestion-sources]');
    const suggestionSummary = planner.querySelector('[data-planner-suggestion-summary]');
    const settingControls = [...planner.querySelectorAll('[data-setting-key]')];
    let suggestionRequestGeneration = 0;
    let suggestionPollTimer = null;
    let suggestionPollController = null;

    settingControls.forEach((control) => {
      const markEdited = () => { control.dataset.userEdited = 'true'; };
      control.addEventListener('input', markEdited);
      control.addEventListener('change', markEdited);
    });

    const setSuggestionStatus = (message, state = 'running') => {
      if (!suggestionStatus) return;
      suggestionPanel?.setAttribute('aria-busy', String(state === 'running'));
      suggestionStatus.hidden = false;
      suggestionStatus.dataset.state = state;
      suggestionStatus.textContent = message;
    };

    const publicList = (value) => Array.isArray(value)
      ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    const rangeLabels = (value) => Array.isArray(value)
      ? value.map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        const start = String(entry?.startLabel || entry?.start || '').trim();
        const end = String(entry?.endLabel || entry?.end || '').trim();
        const count = Number(entry?.atomCount);
        return [
          start && end && start !== end ? `${start}–${end}` : start || end,
          Number.isInteger(count) && count > 0 ? `${count}개 위치` : ''
        ].filter(Boolean).join(' · ');
      }).filter(Boolean)
      : [];

    const sourceLabel = (source) => [
      source?.connectionName || source?.sourceName,
      source?.title,
      source?.versionNo ? `버전 ${source.versionNo}` : ''
    ].filter(Boolean).join(' · ');

    const renderSuggestionSources = (payload) => {
      if (!suggestionSources) return;
      const previousSelections = new Map(
        [...suggestionSources.querySelectorAll('input[name="supplementalSnapshotIds"]')]
          .map((input) => [input.value, input.checked])
      );
      suggestionSources.replaceChildren();
      const sources = payload.sourceSelection || payload.sources || {};
      const primary = sources.primary;
      const included = Array.isArray(sources.included) ? sources.included : [];
      const excluded = Array.isArray(sources.excluded) ? sources.excluded : [];
      if (!primary && !included.length && !excluded.length) {
        suggestionSources.hidden = true;
        return;
      }
      suggestionSources.hidden = false;
      const heading = document.createElement('h3');
      heading.textContent = '생성에 사용할 원본';
      suggestionSources.append(heading);
      if (primary) {
        const primaryRow = document.createElement('article');
        primaryRow.className = 'planner-source-choice primary-source';
        const title = document.createElement('strong');
        title.textContent = `주원본 · ${sourceLabel(primary)}`;
        const reason = document.createElement('p');
        reason.textContent = primary.reason || '현재 Planner에서 선택한 원본을 우선합니다.';
        primaryRow.append(title, reason);
        suggestionSources.append(primaryRow);
      }
      for (const source of included) {
        const snapshotId = source.snapshotId || source.snapshot_id || '';
        const ranges = rangeLabels(source.sourceRanges || source.ranges);
        if (!snapshotId || !ranges.length) continue;
        const row = document.createElement('label');
        row.className = 'planner-source-choice';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'supplementalSnapshotIds';
        checkbox.value = snapshotId;
        checkbox.dataset.suggestionSource = source.suggestionSourceId || '';
        checkbox.dataset.acknowledgementRequired = String(Boolean(source.acknowledgementRequired));
        checkbox.dataset.sourceTitle = source.title || sourceLabel(source);
        checkbox.dataset.sourceRanges = ranges.join(' · ');
        const copy = document.createElement('span');
        const title = document.createElement('strong');
        title.textContent = `보조 원본 · ${sourceLabel(source)}`;
        const reason = document.createElement('small');
        checkbox.checked = previousSelections.has(checkbox.value)
          ? previousSelections.get(checkbox.value)
          : true;
        reason.textContent = [
          source.reason || '현재 원본의 부족한 맥락을 보완합니다.',
          `참조 범위: ${ranges.join(' · ')}`,
          publicList(source.omissions).length ? `누락: ${publicList(source.omissions).join(' · ')}` : ''
        ].filter(Boolean).join(' · ');
        copy.append(title, reason);
        row.append(checkbox, copy);
        suggestionSources.append(row);
      }
      if (included.some((source) => source.acknowledgementRequired)) {
        const acknowledgement = document.createElement('label');
        acknowledgement.className = 'acknowledgement';
        acknowledgement.dataset.supplementalAcknowledgement = 'true';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'supplementalReadinessAcknowledged';
        checkbox.value = 'true';
        checkbox.required = true;
        const copy = document.createElement('span');
        copy.textContent = '포함된 부분 원본의 누락 범위를 확인했으며 표시된 범위 안에서만 생성합니다.';
        acknowledgement.append(checkbox, copy);
        suggestionSources.append(acknowledgement);
        const updateAcknowledgement = (selectionChanged = false) => {
          const partialSelections = [...suggestionSources.querySelectorAll('input[name="supplementalSnapshotIds"]:checked')]
            .filter((input) => input.dataset.acknowledgementRequired === 'true');
          const required = partialSelections.length > 0;
          acknowledgement.hidden = !required;
          checkbox.disabled = !required;
          checkbox.required = required;
          if (!required || selectionChanged) checkbox.checked = false;
          copy.textContent = required
            ? `부분 원본 ${partialSelections.map((input) => `${input.dataset.sourceTitle} (${input.dataset.sourceRanges})`).join(', ')}의 누락 범위를 확인했으며 표시된 범위 안에서만 생성합니다.`
            : '';
        };
        suggestionSources.querySelectorAll('input[name="supplementalSnapshotIds"]')
          .forEach((input) => input.addEventListener('change', () => updateAcknowledgement(true)));
        updateAcknowledgement(false);
      }
      if (excluded.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `분석에서 제외된 원본 ${excluded.length}건`;
        const list = document.createElement('ul');
        for (const source of excluded) {
          const item = document.createElement('li');
          item.textContent = `${sourceLabel(source)} · ${source.reason || '권리 또는 readiness 조건을 충족하지 않음'}`;
          list.append(item);
        }
        details.append(summary, list);
        suggestionSources.append(details);
      }
    };

    const suggestionProfiles = (payload) => {
      if (Array.isArray(payload.profiles)) return payload.profiles;
      return Object.entries(payload.settingsByProfile || {}).map(([profileId, value]) => ({
        profileId,
        ...(value || {})
      }));
    };

    const applySuggestion = (payload) => {
      let applied = 0;
      let preserved = 0;
      for (const profile of suggestionProfiles(payload)) {
        const profileId = profile.profileId || profile.platformProfileVersionId;
        const fieldset = [...planner.querySelectorAll('fieldset[data-platform-profile]')]
          .find((candidate) => candidate.dataset.platformProfile === profileId);
        if (!fieldset) continue;
        const meta = fieldset.querySelector('[data-suggestion-meta]');
        if (profile.status === 'failed') {
          if (meta) {
            meta.hidden = false;
            meta.textContent = profile.message || '이 채널은 자동 추천을 만들지 못했습니다. 수동 입력을 계속 사용할 수 있습니다.';
          }
          continue;
        }
        if (!profile.settings || typeof profile.settings !== 'object') continue;
        for (const [key, value] of Object.entries(profile.settings)) {
          const control = [...fieldset.querySelectorAll('[data-setting-key]')]
            .find((candidate) => candidate.dataset.settingKey === key);
          if (!control) continue;
          if (control.dataset.userEdited === 'true') {
            preserved += 1;
            continue;
          }
          if (control.type === 'checkbox') control.checked = Boolean(value);
          else control.value = String(value ?? '');
          control.dataset.suggestionApplied = 'true';
          applied += 1;
        }
        if (meta) {
          meta.hidden = false;
          const ranges = rangeLabels(profile.sourceRanges || profile.source_ranges);
          const missing = publicList(profile.missingContext || profile.missing_context);
          const effort = profile.expectedEditingEffort || profile.expected_editing_effort || '확인 필요';
          meta.replaceChildren();
          const reason = document.createElement('p');
          reason.textContent = `추천 이유 · ${profile.recommendationReason || profile.recommendation_reason || '원본과 Profile 계약을 함께 분석했습니다.'}`;
          const source = document.createElement('p');
          source.textContent = ranges.length ? `원본 범위 · ${ranges.join(' · ')}` : '원본 범위 · 주원본과 선택된 보조 원본';
          const context = document.createElement('p');
          context.textContent = missing.length ? `누락 맥락 · ${missing.join(' · ')}` : '누락 맥락 · 알려진 추가 누락 없음';
          const editing = document.createElement('p');
          editing.textContent = `예상 편집량 · ${effort}${profile.effortReason ? ` · ${profile.effortReason}` : ''}`;
          meta.append(reason, source, context, editing);
        }
      }
      renderSuggestionSources(payload);
      if (suggestionSummary) {
        suggestionSummary.hidden = false;
        const corpusCount = payload.corpusCount ?? payload.sourceSelection?.consideredCount;
        const includedCount = payload.sourceSelection?.included?.length ?? payload.sources?.included?.length ?? 0;
        suggestionSummary.textContent = `${corpusCount == null ? '주원본과 작업공간 원본' : `주원본과 적격 보조 후보 ${corpusCount}건`}을 분석해 보조 원본 ${includedCount}건과 채널 설정 ${applied}개를 입력했습니다.${preserved ? ` 사용자가 편집한 설정 ${preserved}개는 유지했습니다.` : ''} 채널 선택과 생성은 직접 확인해야 합니다.`;
      }
      planner.elements.plannerSuggestionRunId.value = payload.suggestionRunId || payload.runId || '';
    };

    const pollSuggestion = async (runId, generation) => {
      if (generation !== suggestionRequestGeneration) return;
      try {
        const response = await fetch(`/api/planner-suggestions/${encodeURIComponent(runId)}`, {
          headers: { accept: 'application/json' },
          signal: suggestionPollController?.signal
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message || '추천 상태를 불러오지 못했습니다.');
        const status = payload.status || payload.runStatus;
        if (['succeeded', 'completed'].includes(status)) {
          applySuggestion({ ...payload, suggestionRunId: runId });
          setSuggestionStatus('자동 분석이 완료되었습니다. 입력값과 보조 원본을 확인하세요.', 'succeeded');
          suggestionButton?.removeAttribute('disabled');
          return;
        }
        if (['failed', 'held', 'superseded'].includes(status)) {
          const message = payload.error?.message || payload.message || (status === 'superseded'
            ? '분석 중 원본 또는 Profile이 변경되었습니다. 다시 분석하세요.'
            : '자동 분석에 실패했습니다. 기존 입력은 유지됩니다.');
          setSuggestionStatus(message, 'failed');
          suggestionButton?.removeAttribute('disabled');
          if (suggestionButton) suggestionButton.textContent = '내 소스로 다시 추천';
          return;
        }
        const progress = payload.progress || {};
        const completed = progress.completedBatches ?? progress.completed;
        const total = progress.totalBatches ?? progress.total;
        const stage = progress.label || payload.stageLabel || '작업공간 원본을 분석하고 있습니다.';
        setSuggestionStatus(`${stage}${Number.isFinite(completed) && Number.isFinite(total) ? ` · ${completed}/${total}` : ''}`, 'running');
        const retryAfterMs = Math.min(3_000, Math.max(500, Number(payload.retryAfterMs) || 1_250));
        suggestionPollTimer = setTimeout(() => pollSuggestion(runId, generation), retryAfterMs);
      } catch (error) {
        if (error.name === 'AbortError') return;
        setSuggestionStatus(`${error.message} 기존 입력은 유지됩니다.`, 'failed');
        suggestionButton?.removeAttribute('disabled');
      }
    };

    suggestionButton?.addEventListener('click', async () => {
      const providerId = planner.elements.providerId?.value;
      if (!providerId) {
        setSuggestionStatus('먼저 사용할 Model Provider를 선택하세요.', 'failed');
        planner.elements.providerId?.focus();
        return;
      }
      suggestionRequestGeneration += 1;
      const generation = suggestionRequestGeneration;
      clearTimeout(suggestionPollTimer);
      suggestionPollController?.abort();
      suggestionPollController = new AbortController();
      suggestionButton.setAttribute('disabled', 'disabled');
      setSuggestionStatus('추천 작업을 대기열에 저장하고 있습니다.', 'running');
      try {
        const response = await fetch('/api/planner-suggestions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': requestKey()
          },
          body: JSON.stringify({
            sourceItemId: planner.dataset.plannerSourceItem,
            expectedSnapshotId: planner.dataset.plannerSnapshot,
            providerId,
            creatorIdentityVersionId: planner.elements.creatorIdentityVersionId?.value || null,
            creatorVoiceVersionId: planner.elements.creatorVoiceVersionId?.value || null,
            audiencePersonaVersionId: planner.elements.audiencePersonaVersionId?.value || null
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message || '자동 추천을 시작하지 못했습니다.');
        const runId = payload.suggestionRunId || payload.runId;
        if (!runId) throw new Error('추천 실행 식별자를 받지 못했습니다.');
        planner.elements.plannerSuggestionRunId.value = runId;
        await pollSuggestion(runId, generation);
      } catch (error) {
        setSuggestionStatus(`${error.message} 수동 입력은 계속 사용할 수 있습니다.`, 'failed');
        suggestionButton.removeAttribute('disabled');
      }
    });
    window.addEventListener('pagehide', () => {
      clearTimeout(suggestionPollTimer);
      suggestionPollController?.abort();
    }, { once: true });
  }
  document.querySelectorAll('[data-dialog-open]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.dialogOpen)?.showModal()));
  document.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog')?.close()));
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
  const plannerFields = [...document.querySelectorAll('.planner-form fieldset[data-platform-profile]')];
  const updatePlannerSelectionSummary = () => {
    if (!planner) return;
    const selected = plannerFields.filter((fieldset) => fieldset.querySelector('legend input[name$="_selected"]')?.checked);
    const summary = planner.querySelector('[data-plan-selection-summary]');
    const submit = planner.querySelector('[data-plan-submit]');
    if (summary) {
      summary.textContent = selected.length
        ? `채널 ${selected.length}개 선택됨 · 결과물 ${selected.length}건만 생성합니다.`
        : '생성할 채널을 하나 이상 선택하세요. 선택하지 않은 채널은 생성하지 않습니다.';
    }
    if (submit && submit.dataset.serverDisabled !== 'true') {
      submit.disabled = selected.length === 0;
    }
  };
  plannerFields.forEach((fieldset) => {
    const selected = fieldset.querySelector('legend input[name$="_selected"]');
    const settingsContainer = fieldset.querySelector('[data-channel-settings]');
    if (!selected) return;
    const settings = [...fieldset.querySelectorAll('input,select,textarea')].filter((control) => control !== selected);
    const update = () => {
      settings.forEach((control) => { control.disabled = !selected.checked; });
      if (settingsContainer) {
        settingsContainer.hidden = !selected.checked;
        settingsContainer.inert = !selected.checked;
      }
      fieldset.classList.toggle('unselected-profile', !selected.checked);
      updatePlannerSelectionSummary();
    };
    selected.addEventListener('change', update);
    update();
  });
  document.querySelectorAll('form[data-api]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const submit = form.querySelector('[type="submit"]');
    if (form.matches('.planner-form')) {
      const selected = [...form.querySelectorAll('input[name^="channel_"][name$="_selected"]:checked')];
      if (!selected.length) { tell('생성할 채널을 하나 이상 선택하세요.', 'danger'); return; }
      const missingPurpose = selected.map((checkbox) => checkbox.closest('fieldset')?.querySelector('[data-purpose-setting]')).find((input) => !input?.value.trim());
      if (missingPurpose) { tell('선택한 채널의 목적을 입력하세요.', 'danger'); missingPurpose.focus(); return; }
    }
    if (form.matches('.refresh-form')) {
      const decision = form.elements.decision?.value;
      const provider = form.elements.providerId?.value;
      const note = form.elements.note?.value.trim();
      if (decision !== 'keep' && !provider) {
        tell('부분 새로고침 또는 전체 재생성에 사용할 Provider를 선택하세요.', 'danger');
        form.elements.providerId?.focus();
        return;
      }
      if (decision === 'keep' && !note) {
        tell('현재 결과 유지에는 변경 영향을 확인한 이유를 입력해야 합니다.', 'danger');
        form.elements.note?.focus();
        return;
      }
    }
    submit?.setAttribute('disabled', 'disabled');
    try {
      const values = await formValues(form);
      const response = await fetch(form.dataset.api, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(values) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || '요청을 처리하지 못했습니다.');
      tell('작업이 저장되었습니다. 비동기 작업은 실행 기록에서 상태를 확인할 수 있습니다.', 'success');
      form.closest('dialog')?.close();
      if (form.dataset.runResultRedirect && payload.runId) {
        const redirect = new URL(form.dataset.runResultRedirect, window.location.origin);
        redirect.searchParams.set('run', payload.runId);
        location.assign(`${redirect.pathname}${redirect.search}${redirect.hash}`);
      } else if (form.dataset.redirect) location.assign(form.dataset.redirect);
      else {
        if (form.hasAttribute('data-human-verification-record')) {
          sessionStorage.setItem(`osau-review-resume:${location.pathname}`, 'true');
        }
        location.reload();
      }
    } catch (error) {
      tell(error.message, 'danger');
      submit?.removeAttribute('disabled');
    }
  }));
  const blocks = [...document.querySelectorAll('[data-block-select]')];
  const checks = [...document.querySelectorAll('[data-check-for]')];
  blocks.forEach((block) => block.addEventListener('click', () => {
    blocks.forEach((candidate) => candidate.classList.toggle('selected', candidate === block));
    document.querySelectorAll('.verification-queue-item').forEach((candidate) => {
      const selected = candidate.dataset.blockFocus === block.dataset.blockSelect;
      candidate.classList.toggle('selected', selected);
      candidate.setAttribute('aria-pressed', String(selected));
    });
    checks.forEach((check) => { check.hidden = check.dataset.checkFor !== block.dataset.blockSelect; });
    document.querySelectorAll('[data-source-for]').forEach((source) => source.classList.toggle('selected-source', source.dataset.sourceFor === block.dataset.blockSelect));
    document.querySelectorAll('[data-preview-for]').forEach((context) => { context.hidden = context.dataset.previewFor !== block.dataset.blockSelect; });
    document.querySelectorAll('[data-version-for]').forEach((context) => { context.hidden = context.dataset.versionFor !== block.dataset.blockSelect; });
    document.querySelectorAll('[data-run-for]').forEach((context) => { context.hidden = context.dataset.runFor !== block.dataset.blockSelect; });
    const label = document.querySelector('#selected-block-label');
    if (label) label.textContent = block.dataset.verificationPending === 'true'
      ? '선택한 사실 블록은 현재 원본 대조 기록이 필요합니다. 원본 위치와 문장을 직접 비교하세요.'
      : '선택한 블록의 원본 연결과 미리보기·검사·버전·실행 기록입니다.';
  }));
  const selectBlock = (blockId) => {
    const block = blocks.find((candidate) => candidate.dataset.blockSelect === blockId);
    if (!block) return null;
    block.click();
    return block;
  };
  blocks[0]?.click();
  const workbenchTablist = document.querySelector('.mobile-workbench-tabs');
  if (workbenchTablist) {
    const tabs = [...workbenchTablist.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls'))).filter(Boolean);
    const mobile = window.matchMedia('(max-width: 719px)');
    let activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0];
    const renderTabs = () => {
      if (!mobile.matches) {
        panels.forEach((panel) => { panel.hidden = false; });
        return;
      }
      tabs.forEach((tab) => {
        const selected = tab === activeTab;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
      });
    };
    const activateTab = (tab, focus = false) => {
      activeTab = tab;
      renderTabs();
      if (focus) tab.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateTab(tab));
      tab.addEventListener('keydown', (event) => {
        const last = tabs.length - 1;
        const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
          : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
        if (next == null) return;
        event.preventDefault();
        activateTab(tabs[next], true);
      });
    });
    mobile.addEventListener('change', renderTabs);
    renderTabs();
  }
  const contextTablist = document.querySelector('.review-context-tabs');
  if (contextTablist) {
    const tabs = [...contextTablist.querySelectorAll('[role="tab"]')];
    let activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0];
    const activate = (tab, focus = false) => {
      activeTab = tab;
      tabs.forEach((candidate) => {
        const selected = candidate === activeTab;
        candidate.setAttribute('aria-selected', String(selected));
        candidate.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(candidate.getAttribute('aria-controls'));
        if (panel) panel.hidden = !selected;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', (event) => {
        const last = tabs.length - 1;
        const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
          : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
        if (next == null) return;
        event.preventDefault();
        activate(tabs[next], true);
      });
    });
    activate(activeTab);
  }
  const activateContextTab = (name) => document.getElementById(`context-tab-${name}`)?.click();
  const activateWorkbenchTab = (name) => document.getElementById(`workbench-tab-${name}`)?.click();
  const focusReviewTarget = (control) => {
    const block = control.dataset.blockFocus ? selectBlock(control.dataset.blockFocus) : null;
    if (control.dataset.reviewContext) activateContextTab(control.dataset.reviewContext);
    if (control.dataset.workbenchFocus) activateWorkbenchTab(control.dataset.workbenchFocus);
    if (control.hasAttribute('data-verification-queue-select')) {
      activateContextTab('checks');
      if (window.matchMedia('(max-width: 719px)').matches) {
        activateWorkbenchTab('source');
        const sourcePanel = document.getElementById('workbench-source');
        sourcePanel?.focus({ preventScroll: true });
      }
    }
    const scrollTarget = control.dataset.reviewScroll && document.getElementById(control.dataset.reviewScroll);
    if (scrollTarget) requestAnimationFrame(() => scrollTarget.scrollIntoView({ block: 'start' }));
    return block;
  };
  document.querySelectorAll('[data-block-focus],[data-review-context],[data-workbench-focus]').forEach((control) => control.addEventListener('click', () => {
    focusReviewTarget(control);
  }));
  const verificationResumeKey = `osau-review-resume:${location.pathname}`;
  const resumeVerification = sessionStorage.getItem(verificationResumeKey) === 'true';
  if (resumeVerification) sessionStorage.removeItem(verificationResumeKey);
  const initialVerificationBlock = document.querySelector('[data-verification-default]');
  if (initialVerificationBlock) {
    selectBlock(initialVerificationBlock.dataset.blockSelect);
    if (resumeVerification) activateContextTab('checks');
  }
  document.querySelectorAll('.refresh-form').forEach((form) => {
    const decision = form.elements.decision;
    const providerControl = form.querySelector('[data-provider-control]');
    const update = () => {
      const keeping = decision.value === 'keep';
      providerControl?.classList.toggle('visually-muted', keeping);
      providerControl?.querySelector('select')?.toggleAttribute('disabled', keeping);
    };
    decision.addEventListener('change', update);
    update();
  });
  const liveRefresh = document.querySelector('[data-live-refresh]');
  if (liveRefresh) setTimeout(() => location.reload(), Number(liveRefresh.dataset.liveRefresh) || 5000);
})();
