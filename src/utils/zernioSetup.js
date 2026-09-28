function identifier(value) {
  return String(value && typeof value === 'object' ? (value._id || value.id || '') : (value || '')).trim();
}

function payload(value) {
  return value?.data && typeof value.data === 'object' ? value.data : (value || {});
}

function connectionChoices(numbersResponse, accountsResponse, profilesResponse) {
  const numbers = payload(numbersResponse);
  const accounts = payload(accountsResponse);
  const profiles = payload(profilesResponse);
  const sandbox = numbers.sandbox || null;
  const choices = [];
  const add = (item) => {
    const accountId = identifier(item.accountId);
    const profileId = identifier(item.profileId);
    if (!accountId && !profileId) return;
    if (item.isSandbox || (accountId && accountId === identifier(sandbox?.accountId))) return;
    const existing = choices.find((choice) => accountId && choice.zernioAccountId === accountId)
      || choices.find((choice) => profileId && choice.profileId === profileId
        && (!accountId || !choice.zernioAccountId));
    const choice = existing || { profileId, zernioAccountId: accountId, phoneNumber: '', displayName: '', profileName: '' };
    if (!existing) choices.push(choice);
    choice.profileId ||= profileId;
    choice.zernioAccountId ||= accountId;
    choice.phoneNumber ||= String(item.phoneNumber || '').trim().slice(0, 40);
    choice.displayName ||= String(item.displayName || '').trim().slice(0, 160);
    choice.profileName ||= String(item.profileName || '').trim().slice(0, 160);
  };
  for (const account of (Array.isArray(accounts.accounts) ? accounts.accounts : [])) {
    if (account.platform !== 'whatsapp') continue;
    const username = String(account.username || '').trim();
    add({ accountId: account._id || account.id, profileId: account.profileId,
      profileName: account.profileId?.name, displayName: account.displayName,
      phoneNumber: account.phoneNumber || (/^\+?[\d ()-]{8,}$/.test(username) ? username : ''),
      isSandbox: account.isSandbox });
  }
  for (const number of [...(Array.isArray(numbers.connected) ? numbers.connected : []),
    ...(Array.isArray(numbers.numbers) ? numbers.numbers : [])]) {
    if (['released', 'releasing'].includes(number.status)) continue;
    add({ accountId: number.accountId || number.socialAccountId, profileId: number.profileId,
      profileName: number.profileId?.name, phoneNumber: number.phoneNumber,
      displayName: number.displayName, isSandbox: number.isSandbox });
  }
  for (const profile of (Array.isArray(profiles.profiles) ? profiles.profiles : [])) {
    if (profile.isOverLimit) continue;
    add({ profileId: profile._id || profile.id, profileName: profile.name });
  }
  return choices.map((choice) => ({ ...choice,
    channelId: choice.zernioAccountId ? `account:${choice.zernioAccountId}` : `profile:${choice.profileId}`,
    label: [choice.phoneNumber, choice.displayName || choice.profileName || 'WhatsApp del negocio',
      choice.zernioAccountId ? '' : 'Conectar WhatsApp'].filter(Boolean).join(' · '),
  }));
}

function selectConnectionChoice(choices, { channelId = '', profileId = '', zernioAccountId = '' } = {}) {
  if (channelId) return choices.find((choice) => choice.channelId === channelId) || null;
  if (zernioAccountId) return choices.find((choice) => choice.zernioAccountId === zernioAccountId) || null;
  if (profileId) return choices.find((choice) => choice.profileId === profileId) || null;
  return choices.length === 1 ? choices[0] : null;
}

module.exports = { connectionChoices, selectConnectionChoice };
