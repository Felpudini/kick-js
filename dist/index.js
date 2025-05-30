// src/client/client.ts
import "ws";
import EventEmitter from "events";

// src/core/kickApi.ts
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { authenticator } from "otplib";
var setupPuppeteer = async () => {
  const puppeteerExtra = puppeteer.use(StealthPlugin());
  const browser = await puppeteerExtra.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  return { browser, page };
};
var getChannelData = async (channel) => {
  const { browser, page } = await setupPuppeteer();
  try {
    const response = await page.goto(
      `https://kick.com/api/v2/channels/${channel}`
    );
    if (response?.status() === 403) {
      throw new Error(
        "Request blocked by Cloudflare protection. Please try again later."
      );
    }
    await page.waitForSelector("body");
    const jsonContent = await page.evaluate(() => {
      const bodyElement = document.querySelector("body");
      if (!bodyElement || !bodyElement.textContent) {
        throw new Error("Unable to fetch channel data");
      }
      return JSON.parse(bodyElement.textContent);
    });
    return jsonContent;
  } catch (error) {
    console.error("Error getting channel data:", error);
    return null;
  } finally {
    await browser.close();
  }
};
var getVideoData = async (video_id) => {
  const { browser, page } = await setupPuppeteer();
  try {
    const response = await page.goto(
      `https://kick.com/api/v1/video/${video_id}`
    );
    if (response?.status() === 403) {
      throw new Error(
        "Request blocked by Cloudflare protection. Please try again later."
      );
    }
    await page.waitForSelector("body");
    const jsonContent = await page.evaluate(() => {
      const bodyElement = document.querySelector("body");
      if (!bodyElement || !bodyElement.textContent) {
        throw new Error("Unable to fetch video data");
      }
      return JSON.parse(bodyElement.textContent);
    });
    return jsonContent;
  } catch (error) {
    console.error("Error getting video data:", error);
    return null;
  } finally {
    await browser.close();
  }
};
var authentication = async ({
  username,
  password,
  otp_secret
}) => {
  let bearerToken = "";
  let xsrfToken = "";
  let cookieString = "";
  let isAuthenticated = false;
  const puppeteerExtra = puppeteer.use(StealthPlugin());
  const browser = await puppeteerExtra.launch({
    headless: true,
    defaultViewport: null
  });
  const page = await browser.newPage();
  let requestData = [];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    const headers = request.headers();
    if (url.includes("/api/v2/channels/followed")) {
      const reqBearerToken = headers["authorization"] || "";
      cookieString = headers["cookie"] || "";
      if (!bearerToken && reqBearerToken.includes("Bearer ")) {
        const splitToken = reqBearerToken.split("Bearer ")[1];
        if (splitToken) {
          bearerToken = splitToken;
        }
      }
    }
    requestData.push({
      url,
      headers,
      method: request.method(),
      resourceType: request.resourceType()
    });
    request.continue();
  });
  const selectorTimeout = 6e3;
  try {
    await page.goto("https://kick.com/");
    await page.waitForSelector("nav > div:nth-child(3) > button:first-child", {
      visible: true,
      timeout: selectorTimeout
    });
    await page.click("nav > div:nth-child(3) > button:first-child");
    await page.waitForSelector('input[name="emailOrUsername"]', {
      visible: true,
      timeout: selectorTimeout
    });
    await page.type('input[name="emailOrUsername"]', username, { delay: 100 });
    await page.type('input[name="password"]', password, { delay: 100 });
    await page.click('button[data-test="login-submit"]');
    try {
      await page.waitForFunction(
        () => {
          const element = document.querySelector(
            'input[data-input-otp="true"]'
          );
          const verifyText = document.body.textContent?.includes("Verify 2FA Code");
          return element || !verifyText;
        },
        { timeout: selectorTimeout }
      );
      const requires2FA = await page.evaluate(() => {
        return !!document.querySelector('input[data-input-otp="true"]');
      });
      if (requires2FA) {
        if (!otp_secret) {
          throw new Error("2FA authentication required");
        }
        const token = authenticator.generate(otp_secret);
        await page.waitForSelector('input[data-input-otp="true"]');
        await page.type('input[data-input-otp="true"]', token, { delay: 100 });
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: "networkidle0" });
      }
    } catch (error) {
      if (error.message.includes("2FA authentication required")) throw error;
    }
    await page.goto("https://kick.com/api/v2/channels/followed");
    const cookies = await page.cookies();
    cookieString = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const xsrfTokenCookie = cookies.find(
      (cookie) => cookie.name === "XSRF-TOKEN"
    )?.value;
    if (xsrfTokenCookie) {
      xsrfToken = xsrfTokenCookie;
    }
    if (!cookieString || cookieString === "") {
      throw new Error("Failed to capture cookies");
    }
    if (!bearerToken || bearerToken === "") {
      throw new Error("Failed to capture bearer token");
    }
    if (!xsrfToken || xsrfToken === "") {
      throw new Error("Failed to capture xsrf token");
    }
    isAuthenticated = true;
    return {
      bearerToken,
      xsrfToken,
      cookies: cookieString,
      isAuthenticated
    };
  } catch (error) {
    throw error;
  } finally {
    await browser.close();
  }
};

// src/core/websocket.ts
import WebSocket from "ws";
import { URLSearchParams } from "url";
var BASE_URL = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679";
var createWebSocket = (chatroomId) => {
  const urlParams = new URLSearchParams({
    protocol: "7",
    client: "js",
    version: "7.4.0",
    flash: "false"
  });
  const url = `${BASE_URL}?${urlParams.toString()}`;
  const socket = new WebSocket(url);
  socket.on("open", () => {
    const connect = JSON.stringify({
      event: "pusher:subscribe",
      data: { auth: "", channel: `chatrooms.${chatroomId}.v2` }
    });
    socket.send(connect);
  });
  return socket;
};

// src/utils/utils.ts
var parseJSON = (json) => JSON.parse(json);
var validateCredentials = (options) => {
  const { type, credentials } = options;
  switch (type) {
    case "login":
      if (!credentials.username || typeof credentials.username !== "string") {
        throw new Error("Username is required and must be a string");
      }
      if (!credentials.password || typeof credentials.password !== "string") {
        throw new Error("Password is required and must be a string");
      }
      if (!credentials.otp_secret || typeof credentials.otp_secret !== "string") {
        throw new Error("OTP secret is required and must be a string");
      }
      break;
    case "tokens":
      if (!credentials.bearerToken || typeof credentials.bearerToken !== "string") {
        throw new Error("bearerToken is required and must be a string");
      }
      if (!credentials.xsrfToken || typeof credentials.xsrfToken !== "string") {
        throw new Error("xsrfToken is required and must be a string");
      }
      if (!credentials.cookies || typeof credentials.cookies !== "string") {
        throw new Error("cookies are required and must be a string");
      }
      break;
    default:
      throw new Error("Invalid login type");
  }
};

// src/core/messageHandling.ts
var parseMessage = (message) => {
  try {
    const messageEventJSON = parseJSON(message);
    switch (messageEventJSON.event) {
      case "App\\Events\\ChatMessageEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "ChatMessage", data };
      }
      case "App\\Events\\SubscriptionEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "Subscription", data };
      }
      case "App\\Events\\GiftedSubscriptionsEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "GiftedSubscriptions", data };
      }
      case "App\\Events\\StreamHostEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "StreamHost", data };
      }
      case "App\\Events\\MessageDeletedEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "MessageDeleted", data };
      }
      case "App\\Events\\UserBannedEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "UserBanned", data };
      }
      case "App\\Events\\UserUnbannedEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "UserUnbanned", data };
      }
      case "App\\Events\\PinnedMessageCreatedEvent": {
        const data = parseJSON(
          messageEventJSON.data
        );
        return { type: "PinnedMessageCreated", data };
      }
      case "App\\Events\\PinnedMessageDeletedEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "PinnedMessageDeleted", data };
      }
      case "App\\Events\\PollUpdateEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "PollUpdate", data };
      }
      case "App\\Events\\PollDeleteEvent": {
        const data = parseJSON(messageEventJSON.data);
        return { type: "PollDelete", data };
      }
      default: {
        console.log("Unknown event type:", messageEventJSON.event);
        return null;
      }
    }
    return null;
  } catch (error) {
    console.error("Error parsing message:", error);
    return null;
  }
};

// src/core/requestHelper.ts
import axios from "axios";
import { AxiosHeaders } from "axios";
var createHeaders = ({
  bearerToken,
  cookies,
  channelSlug
}) => {
  const headers = new AxiosHeaders();
  headers.set("accept", "application/json");
  headers.set("accept-language", "en-US,en;q=0.9");
  headers.set("authorization", `Bearer ${bearerToken}`);
  headers.set("cache-control", "max-age=0");
  headers.set("cluster", "v2");
  headers.set("content-type", "application/json");
  headers.set("priority", "u=1, i");
  headers.set("cookie", cookies);
  headers.set("Referer", `https://kick.com/${channelSlug}`);
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return headers;
};
var makeRequest = async (method, url, headers, data) => {
  try {
    const response = await axios({
      method,
      url,
      headers,
      data
    });
    if (response.status === 200) {
      return response.data;
    }
    console.error(`Request failed with status: ${response.status}`);
    return null;
  } catch (error) {
    console.error(`Request error for ${url}:`, error);
    return null;
  }
};

// src/client/client.ts
var createClient = (channelName, options = {}) => {
  const emitter = new EventEmitter();
  let socket = null;
  let channelInfo = null;
  let videoInfo = null;
  let clientToken = null;
  let clientCookies = null;
  let clientBearerToken = null;
  let isLoggedIn = false;
  const defaultOptions = {
    plainEmote: true,
    logger: false,
    readOnly: false
  };
  const mergedOptions = { ...defaultOptions, ...options };
  const checkAuth = () => {
    if (!isLoggedIn) {
      throw new Error("Authentication required. Please login first.");
    }
    if (!clientBearerToken) {
      throw new Error("Missing bearer token");
    }
    if (!clientCookies) {
      throw new Error("Missing cookies");
    }
  };
  const login = async (options2) => {
    const { type, credentials } = options2;
    try {
      switch (type) {
        case "login":
          if (!credentials) {
            throw new Error("Credentials are required for login");
          }
          validateCredentials(options2);
          if (mergedOptions.logger) {
            console.log("Starting authentication process with login ...");
          }
          const { bearerToken, xsrfToken, cookies, isAuthenticated } = await authentication({
            username: credentials.username,
            password: credentials.password,
            otp_secret: credentials.otp_secret
          });
          if (mergedOptions.logger) {
            console.log("Authentication tokens received, validating...");
          }
          clientBearerToken = bearerToken;
          clientToken = xsrfToken;
          clientCookies = cookies;
          isLoggedIn = isAuthenticated;
          if (!isAuthenticated) {
            throw new Error("Authentication failed");
          }
          if (mergedOptions.logger) {
            console.log("Authentication successful, initializing client...");
          }
          await initialize();
          break;
        case "tokens":
          if (!credentials) {
            throw new Error("Tokens are required for login");
          }
          if (mergedOptions.logger) {
            console.log("Starting authentication process with tokens ...");
          }
          clientBearerToken = credentials.bearerToken;
          clientToken = credentials.xsrfToken;
          clientCookies = credentials.cookies;
          isLoggedIn = true;
          await initialize();
          break;
        default:
          throw new Error("Invalid authentication type");
      }
      return true;
    } catch (error) {
      console.error("Login failed:", error);
      throw error;
    }
  };
  const initialize = async () => {
    try {
      if (mergedOptions.readOnly === false && !isLoggedIn) {
        throw new Error("Authentication required. Please login first.");
      }
      if (mergedOptions.logger) {
        console.log(`Fetching channel data for: ${channelName}`);
      }
      channelInfo = await getChannelData(channelName);
      if (!channelInfo) {
        throw new Error("Unable to fetch channel data");
      }
      if (mergedOptions.logger) {
        console.log(
          "Channel data received, establishing WebSocket connection..."
        );
      }
      socket = createWebSocket(channelInfo.chatroom.id);
      socket.on("open", () => {
        if (mergedOptions.logger) {
          console.log(`Connected to channel: ${channelName}`);
        }
        emitter.emit("ready", getUser());
      });
      socket.on("message", (data) => {
        const parsedMessage = parseMessage(data.toString());
        if (parsedMessage) {
          switch (parsedMessage.type) {
            case "ChatMessage":
              if (mergedOptions.plainEmote) {
                const messageData = parsedMessage.data;
                messageData.content = messageData.content.replace(
                  /\[emote:(\d+):(\w+)\]/g,
                  (_, __, emoteName) => emoteName
                );
              }
              break;
            case "Subscription":
              break;
            case "GiftedSubscriptions":
              break;
            case "StreamHostEvent":
              break;
            case "UserBannedEvent":
              break;
            case "UserUnbannedEvent":
              break;
            case "PinnedMessageCreatedEvent":
              break;
          }
          emitter.emit(parsedMessage.type, parsedMessage.data);
        }
      });
      socket.on("close", () => {
        if (mergedOptions.logger) {
          console.log(`Disconnected from channel: ${channelName}`);
        }
        emitter.emit("disconnect");
      });
      socket.on("error", (error) => {
        console.error("WebSocket error:", error);
        emitter.emit("error", error);
      });
    } catch (error) {
      console.error("Error during initialization:", error);
      throw error;
    }
  };
  if (mergedOptions.readOnly === true) {
    void initialize();
  }
  const on = (event, listener) => {
    emitter.on(event, listener);
  };
  const getUser = () => channelInfo ? {
    id: channelInfo.id,
    username: channelInfo.slug,
    tag: channelInfo.user.username
  } : null;
  const vod = async (video_id) => {
    videoInfo = await getVideoData(video_id);
    if (!videoInfo) {
      throw new Error("Unable to fetch video data");
    }
    return {
      id: videoInfo.id,
      title: videoInfo.livestream.session_title,
      thumbnail: videoInfo.livestream.thumbnail,
      duration: videoInfo.livestream.duration,
      live_stream_id: videoInfo.live_stream_id,
      start_time: videoInfo.livestream.start_time,
      created_at: videoInfo.created_at,
      updated_at: videoInfo.updated_at,
      uuid: videoInfo.uuid,
      views: videoInfo.views,
      stream: videoInfo.source,
      language: videoInfo.livestream.language,
      livestream: videoInfo.livestream,
      channel: videoInfo.livestream.channel
    };
  };
  const sendMessage = async (messageContent) => {
    if (!channelInfo) {
      throw new Error("Channel info not available");
    }
    if (messageContent.length > 500) {
      throw new Error("Message content must be less than 500 characters");
    }
    if (!clientCookies) {
      throw new Error("WebSocket connection not established");
    }
    if (!clientBearerToken) {
      throw new Error("WebSocket connection not established");
    }
    const res = fetch(
      `https://kick.com/api/v2/messages/send/${channelInfo.chatroom.id}`,
      {
        headers: {
          accept: "application/json",
          "accept-language": "en-US,en;q=0.9",
          authorization: `Bearer ${clientBearerToken}`,
          "cache-control": "max-age=0",
          cluster: "v2",
          "content-type": "application/json",
          priority: "u=1, i",
          "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="132"',
          "sec-ch-ua-arch": '"arm"',
          "sec-ch-ua-bitness": '"64"',
          "sec-ch-ua-full-version": '"132.0.6834.111"',
          "sec-ch-ua-full-version-list": '"Not A(Brand";v="8.0.0.0", "Chromium";v="132.0.6834.111"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-model": '""',
          "sec-ch-ua-platform": '"macOS"',
          "sec-ch-ua-platform-version": '"15.0.1"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          cookie: clientCookies,
          Referer: `https://kick.com/${channelInfo.slug}`,
          "Referrer-Policy": "strict-origin-when-cross-origin"
        },
        body: `{"content":"${messageContent}","type":"message"}`,
        method: "POST"
      }
    );
  };
  const banUser = async (targetUser, durationInMinutes, permanent = false) => {
    if (!channelInfo) {
      throw new Error("Channel info not available");
    }
    checkAuth();
    if (!targetUser) {
      throw new Error("Specify a user to ban");
    }
    if (!permanent) {
      if (!durationInMinutes) {
        throw new Error("Specify a duration in minutes");
      }
      if (durationInMinutes < 1) {
        throw new Error("Duration must be more than 0 minutes");
      }
    }
    const headers = createHeaders({
      bearerToken: clientBearerToken,
      xsrfToken: clientToken,
      cookies: clientCookies,
      channelSlug: channelInfo.slug
    });
    try {
      const data = permanent ? { banned_username: targetUser, permanent: true } : {
        banned_username: targetUser,
        duration: durationInMinutes,
        permanent: false
      };
      const result = await makeRequest(
        "post",
        `https://kick.com/api/v2/channels/${channelInfo.id}/bans`,
        headers,
        data
      );
      if (result) {
        console.log(
          `User ${targetUser} ${permanent ? "banned" : "timed out"} successfully`
        );
      } else {
        console.error(`Failed to ${permanent ? "ban" : "time out"} user.`);
      }
    } catch (error) {
      console.error(
        `Error ${permanent ? "banning" : "timing out"} user:`,
        error
      );
    }
  };
  const unbanUser = async (targetUser) => {
    if (!channelInfo) {
      throw new Error("Channel info not available");
    }
    checkAuth();
    if (!targetUser) {
      throw new Error("Specify a user to unban");
    }
    const headers = createHeaders({
      bearerToken: clientBearerToken,
      xsrfToken: clientToken,
      cookies: clientCookies,
      channelSlug: channelInfo.slug
    });
    try {
      const result = await makeRequest(
        "delete",
        `https://kick.com/api/v2/channels/${channelInfo.id}/bans/${targetUser}`,
        headers
      );
      if (result) {
        console.log(`User ${targetUser} unbanned successfully`);
      } else {
        console.error(`Failed to unban user.`);
      }
    } catch (error) {
      console.error("Error unbanning user:", error);
    }
  };
  const deleteMessage = async (messageId) => {
    if (!channelInfo) {
      throw new Error("Channel info not available");
    }
    checkAuth();
    if (!messageId) {
      throw new Error("Specify a messageId to delete");
    }
    const headers = createHeaders({
      bearerToken: clientBearerToken,
      xsrfToken: clientToken,
      cookies: clientCookies,
      channelSlug: channelInfo.slug
    });
    try {
      const result = await makeRequest(
        "delete",
        `https://kick.com/api/v2/channels/${channelInfo.id}/messages/${messageId}`,
        headers
      );
      if (result) {
        console.log(`Message ${messageId} deleted successfully`);
      } else {
        console.error(`Failed to delete message.`);
      }
    } catch (error) {
      console.error("Error deleting message:", error);
    }
  };
  const slowMode = async (mode, durationInSeconds) => {
    if (!channelInfo) {
      throw new Error("Channel info not available");
    }
    checkAuth();
    if (mode !== "on" && mode !== "off") {
      throw new Error("Invalid mode, must be either 'on' or 'off'");
    }
    if (mode === "on" && (!durationInSeconds || durationInSeconds < 1)) {
      throw new Error(
        "Invalid duration, must be greater than 0 if mode is 'on'"
      );
    }
    const headers = createHeaders({
      bearerToken: clientBearerToken,
      xsrfToken: clientToken,
      cookies: clientCookies,
      channelSlug: channelInfo.slug
    });
    try {
      const data = mode === "off" ? { slow_mode: false } : { slow_mode: true, message_interval: durationInSeconds };
      const result = await makeRequest(
        "put",
        `https://kick.com/api/v2/channels/${channelInfo.slug}/chatroom`,
        headers,
        data
      );
      if (result?.success) {
        console.log(
          mode === "off" ? "Slow mode disabled successfully" : `Slow mode enabled with ${durationInSeconds} second interval`
        );
      } else {
        console.error(
          `Failed to ${mode === "off" ? "disable" : "enable"} slow mode.`
        );
      }
    } catch (error) {
      console.error(
        `Error ${mode === "off" ? "disabling" : "enabling"} slow mode:`,
        error
      );
    }
  };
  const getPoll = async (targetChannel) => {
    const channel = targetChannel || channelName;
    if (!targetChannel && !channelInfo) {
      throw new Error("Channel info not available");
    }
    const headers = createHeaders({
      bearerToken: clientBearerToken,
      xsrfToken: clientToken,
      cookies: clientCookies,
      channelSlug: channel
    });
    try {
      const result = await makeRequest(
        "get",
        `https://kick.com/api/v2/channels/${channel}/polls`,
        headers
      );
      if (result) {
        console.log(`Poll retrieved successfully for channel: ${channel}`);
        return result;
      }
    } catch (error) {
      console.error(`Error retrieving poll for channel ${channel}:`, error);
    }
    return null;
  };
  const getLeaderboards = async (targetChannel) => {
    const channel = targetChannel || channelName;
    if (!targetChannel && !channelInfo) {
      throw new Error("Channel info not available");
    }
    const headers = createHeaders({
      bearerToken: clientBearerToken,
      xsrfToken: clientToken,
      cookies: clientCookies,
      channelSlug: channel
    });
    try {
      const result = await makeRequest(
        "get",
        `https://kick.com/api/v2/channels/${channel}/leaderboards`,
        headers
      );
      if (result) {
        console.log(
          `Leaderboards retrieved successfully for channel: ${channel}`
        );
        return result;
      }
    } catch (error) {
      console.error(
        `Error retrieving leaderboards for channel ${channel}:`,
        error
      );
    }
    return null;
  };
  return {
    login,
    on,
    get user() {
      return getUser();
    },
    vod,
    sendMessage,
    banUser,
    unbanUser,
    deleteMessage,
    slowMode,
    getPoll,
    getLeaderboards
  };
};
export {
  createClient
};
