/*
 * Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
 * Purpose: Small Genesys Cloud API wrapper used by GCB modules.
 *          Centralizes authenticated GET, POST, and PATCH calls with consistent error handling.
 */
/* GCB Genesys API Helpers v1.0.0 */
(function (global) {
  "use strict";

  const C = global.RakCommon;
  const Auth = global.RakAuth;

  async function genesysFetch(path, options) {
    options = options || {};
    const token = options.token || Auth.getAccessToken();
    if (!token) throw new Error("OAuth token missing.");

    const response = await fetch(Auth.getApiBase() + path, {
      method: options.method || "GET",
      headers: Object.assign({
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      }, options.headers || {}),
      body: options.body !== undefined ? options.body : undefined
    });

    const text = await response.text();
    const data = C.parseJson(text);
    if (!response.ok) {
      const error = new Error((data && (data.message || data.error)) || ("Genesys API failed. HTTP " + response.status + " - " + text));
      error.status = response.status;
      error.payload = data;
      error.rawText = text;
      if (response.status === 401) Auth.clearToken();
      throw error;
    }

    return data;
  }

  async function getMessageConversation(token, conversationId) {
    return genesysFetch("/api/v2/conversations/messages/" + encodeURIComponent(conversationId), { token });
  }

  function extractCommunicationIdFromParticipant(participant) {
    if (!participant) return "";
    const arrays = [participant.messages, participant.message, participant.communications, participant.chats];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) continue;
      const connected = arr.find(x => x && x.id && ["connected", "alerting", "dialing"].includes(C.safeString(x.state).toLowerCase()));
      if (connected && connected.id) return connected.id;
      const firstWithId = arr.find(x => x && x.id);
      if (firstWithId && firstWithId.id) return firstWithId.id;
    }
    return "";
  }

  function extractBestCommunicationId(conversation, preferredPurpose) {
    const participants = Array.isArray(conversation && conversation.participants) ? conversation.participants : [];
    const purposes = preferredPurpose ? [preferredPurpose] : ["customer", "external", "agent"];
    for (const purpose of purposes) {
      for (const p of participants) {
        if (C.safeString(p && p.purpose).toLowerCase() !== purpose) continue;
        const id = extractCommunicationIdFromParticipant(p);
        if (id) return id;
      }
    }
    for (const p of participants) {
      const id = extractCommunicationIdFromParticipant(p);
      if (id) return id;
    }
    return "";
  }

  function findParticipantByCommunicationId(conversation, communicationId) {
    const participants = Array.isArray(conversation && conversation.participants) ? conversation.participants : [];
    const target = C.safeString(communicationId);
    if (!target) return null;
    return participants.find(function (p) {
      const arrays = [p.messages, p.message, p.communications, p.chats];
      return arrays.some(function (arr) {
        return Array.isArray(arr) && arr.some(x => x && C.safeString(x.id) === target);
      });
    }) || null;
  }

  async function resolveCommunicationContext(token, conversationId, options) {
    options = options || {};
    const conversation = await getMessageConversation(token, conversationId);

    let customerCommunicationId = C.safeString(options.customerCommunicationId);
    if (!customerCommunicationId) {
      customerCommunicationId = extractBestCommunicationId(conversation, "customer") || extractBestCommunicationId(conversation, "external") || extractBestCommunicationId(conversation);
    }

    let agentCommunicationId = C.safeString(options.agentCommunicationId);
    let agentParticipantId = C.safeString(options.agentParticipantId || options.participantId);

    if (agentCommunicationId) {
      const agentParticipant = findParticipantByCommunicationId(conversation, agentCommunicationId);
      if (agentParticipant && !agentParticipantId) agentParticipantId = C.safeString(agentParticipant.id);
    }

    if (!agentCommunicationId && agentParticipantId) {
      const participants = Array.isArray(conversation.participants) ? conversation.participants : [];
      const agentParticipant = participants.find(p => C.safeString(p && p.id) === agentParticipantId);
      agentCommunicationId = extractCommunicationIdFromParticipant(agentParticipant);
    }

    return {
      conversation,
      customerCommunicationId,
      agentCommunicationId,
      agentParticipantId
    };
  }

  async function sendMessage(token, conversationId, communicationId, textBody) {
    return genesysFetch(
      "/api/v2/conversations/messages/" + encodeURIComponent(conversationId) +
      "/communications/" + encodeURIComponent(communicationId) + "/messages",
      {
        token,
        method: "POST",
        body: JSON.stringify({ textBody: textBody })
      }
    );
  }

  async function setParticipantAttributes(token, conversationId, participantId, attributes) {
    return genesysFetch(
      "/api/v2/conversations/messages/" + encodeURIComponent(conversationId) +
      "/participants/" + encodeURIComponent(participantId) + "/attributes",
      {
        token,
        method: "PATCH",
        body: JSON.stringify({ attributes: attributes || {} })
      }
    );
  }

  async function getCurrentUser(token) {
    return genesysFetch("/api/v2/users/me?expand=authorization", { token });
  }

  global.GenesysApi = {
    genesysFetch,
    getMessageConversation,
    extractCommunicationIdFromParticipant,
    extractBestCommunicationId,
    findParticipantByCommunicationId,
    resolveCommunicationContext,
    sendMessage,
    setParticipantAttributes,
    getCurrentUser
  };
})(window);
