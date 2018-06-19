const debug = require('debug')('qcloud-sdk[auth]')
const http = require('axios')
const moment = require('moment')
const config = require('../../config')
const qcloudProxyLogin = require('../helper/qcloudProxyLogin')
const AuthDbService = require('../mysql/AuthDbService')
const sha1 = require('../helper/sha1')
const aesDecrypt = require('../helper/aesDecrypt')
const { ERRORS, LOGIN_STATE } = require('../constants')
const Redis = require('ioredis')

/**
 * 授权模块
 * @param {express request} req
 * @return {Promise}
 * @example 基于 Express
 * authorization(this.req).then(userinfo => { // ...some code })
 */
function authorization(req) {
    const {
        'x-wx-code': code,
        'referer': referer
    } = req.headers
    // 检查 headers
    const patt = "servicewechat.com\/([A-Za-z0-9]+)"
    let ret = referer.match(patt)
    let thirdAppId =  ret[1]
    if ([code, referer].some(v => !v)) {
        debug(ERRORS.ERR_HEADER_MISSED)
        throw new Error(ERRORS.ERR_HEADER_MISSED)
    }

    debug('Auth: code: %s, encryptedData: %s, iv: %s', code, thirdAppId)
    // 获取 session key
    return getSessionKey(code, thirdAppId)
        .then(pkg => {
            const { session_key, openid } = pkg
            // 生成 3rd_session
            const skey = sha1(session_key)

            // 存储到数据库中
            return AuthDbService.saveUserInfo(openid, skey, session_key, thirdAppId).then(userinfo => ({
                loginState: LOGIN_STATE.SUCCESS,
                user: userinfo[0],
                uid: userinfo[0].uid,
                aid: userinfo[0].aid
            }))
        })
}

/**
 * 鉴权模块
 * @param {express request} req
 * @return {Promise}
 * @example 基于 Express
 * validation(this.req).then(loginState => { // ...some code })
 */
function validation(req) {
    const { 'x-wx-skey': skey } = req.headers
    if (!skey) throw new Error(ERRORS.ERR_SKEY_INVALID)

    debug('Valid: skey: %s', skey)

    return AuthDbService.getUserInfoBySKey(skey)
        .then(result => {
            if (result.length === 0) throw new Error(ERRORS.ERR_SKEY_INVALID)
            else result = result[0]
            // 效验登录态是否过期
            const { last_visit_time: lastVisitTime } = result
            const expires = config.wxLoginExpires && !isNaN(parseInt(config.wxLoginExpires)) ? parseInt(config.wxLoginExpires) * 1000 : 7200 * 1000

            if (moment(lastVisitTime, 'YYYY-MM-DD HH:mm:ss').valueOf() + expires < Date.now()) {
                debug('Valid: skey expired, login failed.')
                return {
                    loginState: LOGIN_STATE.FAILED,
                    // userinfo: {},
                    user: {},
                    uid: '',
                    aid: '',
                }
            } else {
                debug('Valid: login success.')
                return {
                    loginState: LOGIN_STATE.SUCCESS,
                    user: result,
                    uid: result.uid,
                    aid: result.aid,
                }
            }
        })
}

/**
 * Koa 授权中间件
 * 基于 authorization 重新封装
 * @param {koa context} ctx koa 请求上下文
 * @return {Promise}
 */
function authorizationMiddleware(ctx, next) {
    return authorization(ctx.req).then(result => {
        ctx.state.$wxInfo = result
        return next()
    })
}

/**
 * Koa 鉴权中间件
 * 基于 validation 重新封装
 * @param {koa context} ctx koa 请求上下文
 * @return {Promise}
 */
function validationMiddleware(ctx, next) {
    return validation(ctx.req).then(result => {
        ctx.state.$wxInfo = result
        return next()
    })
}

function authInfoMiddleware (ctx, next) {
    const { 'x-wx-skey': skey } = ctx.req.headers
    debug('Valid: skey: %s', skey)
    if (!skey) {
        return next()
    } else {
        return AuthDbService.getUserInfoBySKey(skey).then(result => {
            if (result.length === 0) throw new Error(ERRORS.ERR_SKEY_INVALID)
            else result = result[0]
            ctx.state.$wxInfo = {user: result}
            return next()
        })
    }
}

/**
 * session key 交换
 * @param {string} appid
 * @param {string} appsecret
 * @param {string} code
 * @return {Promise}
 */
function getSessionKey(code, thirdAppId) {
    const useQcloudLogin = config.useQcloudLogin
    // 使用腾讯云代小程序登录
    if (useQcloudLogin) {
        const { qcloudSecretId, qcloudSecretKey } = config
        return qcloudProxyLogin(qcloudSecretId, qcloudSecretKey, code).then(res => {
            res = res.data
            if (res.code !== 0 || !res.data.openid || !res.data.session_key) {
                debug('%s: %O', ERRORS.ERR_GET_SESSION_KEY, res)
                throw new Error(`${ERRORS.ERR_GET_SESSION_KEY}\n${JSON.stringify(res)}`)
            } else {
                debug('openid: %s, session_key: %s', res.data.openid, res.data.session_key)
                return res.data
            }
        })
    } else {
        const appid = config.appId
        const redis = new Redis({
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            db: config.redis.db
        });
        return redis.get('component_access_token').then(accessToken => {
            return http({
                url: 'https://api.weixin.qq.com/sns/component/jscode2session',
                method: 'GET',
                params: {
                    appid: thirdAppId,
                    js_code: code,
                    grant_type: 'authorization_code',
                    component_appid: appid,
                    component_access_token: accessToken
                }
            }).then(res => {
                res = res.data
                if (res.errcode || !res.openid || !res.session_key) {
                    debug('%s: %O', ERRORS.ERR_GET_SESSION_KEY, res.errmsg)
                    throw new Error(`${ERRORS.ERR_GET_SESSION_KEY}\n${JSON.stringify(res)}`)
                } else {
                    debug('openid: %s, session_key: %s', res.openid, res.session_key)
                    return res
                }
            })
        })
    }
}

module.exports = {
    authorization,
    validation,
    authorizationMiddleware,
    validationMiddleware,
    authInfoMiddleware,
}
