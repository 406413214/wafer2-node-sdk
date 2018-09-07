const debug = require('debug')('qcloud-sdk[AuthDbService]')
const moment = require('moment')
const ERRORS = require('../constants').ERRORS
const mysql = require('./index')
const Redis = require('ioredis')
const config = require('../../config')

/**
 * 储存用户信息
 * @param {object} userInfo
 * @param {string} sessionKey
 * @return {Promise}
 */
function saveUserInfo(open_id, skey, session_key, thirdAppId, aid) {
    const last_visit_time = moment().format('YYYY-MM-DD HH:mm:ss')
    const created_at = last_visit_time
    // 查重并决定是插入还是更新数据
    return mysql('user').count('open_id as hasUser').where({
        open_id
    }).then(res => {
        // 如果存在用户则更新
        if (res[0].hasUser) {
            return mysql('user').update({
                open_id, skey, last_visit_time, session_key
            }).where({
                open_id
            })
        } else {
            let where = {}
            if (aid) {
                where.aid = aid
            } else {
                where.app_id = thirdAppId
            }
            return mysql('app').select('aid', 'type', 'owner_uid').where(where).then(res => {
                if (!aid) {
                    aid = res[0].aid
                }
                let appType = res[0].type
                let ownerUid = res[0].owner_uid
                const redis = new Redis({
                    host: config.redis.host,
                    port: config.redis.port,
                    password: config.redis.password,
                    db: config.redis.db
                });
                // 检测app访问用户数量
                return redis.exists(`app:${aid}:usercount`).then(userCount => {
                    if (parseInt(userCount) === 0) {
                        // 如果没有人访问过app，检测app是否已经设置主播
                        return mysql('user').insert({
                            open_id, skey, created_at, last_visit_time, aid, open_id, session_key
                        }).then(uid => {
                            if (!ownerUid) {
                                // 没有设置过主播，第一次访问的人默认为主播, app表绑定owner_uid，并且绑定anchor.uid
                                return mysql('app').update({
                                    owner_uid: uid
                                }).where({aid: aid}).then(res => {
                                    return mysql('anchor').update({
                                        uid: uid
                                    }).where({aid: aid}).then(res => {
                                        // 公共版才记录访问app
                                        if (parseInt(appType) === 0) {
                                            return redis.incr(`app:${aid}:usercount`).then(incr => {
                                                return redis.sadd(`u:${uid}:aid`, aid)
                                            })
                                        } else {
                                            return redis.incr(`app:${aid}:usercount`)
                                        }
                                    })
                                })
                            } else {
                                // 公共版才记录访问app
                                if (parseInt(appType) === 0) {
                                    return redis.incr(`app:${aid}:usercount`).then(incr => {
                                        return redis.sadd(`u:${uid}:aid`, aid)
                                    })
                                } else {
                                    return redis.incr(`app:${aid}:usercount`)
                                }
                            }
                        })
                    } else {
                        if (parseInt(appType) === 0) {
                            // 公共版才记录访问app
                            return mysql('user').insert({
                                open_id, skey, created_at, last_visit_time, aid, open_id, session_key
                            }).then(ret => {
                                return redis.sadd(`u:${ret}:aid`, aid)
                            })
                        } else {
                            return mysql('user').insert({
                                open_id, skey, created_at, last_visit_time, aid, open_id, session_key
                            })
                        }
                    }
                })
            })
        }
    }).then(() => {
        return getUserInfoBySKey(skey)
    }).catch(e => {
        debug('%s: %O', ERRORS.DBERR.ERR_WHEN_INSERT_TO_DB, e)
        throw new Error(`${ERRORS.DBERR.ERR_WHEN_INSERT_TO_DB}\n${e}`)
    })
}

/**
 * 通过 skey 获取用户信息
 * @param {string} skey 登录时颁发的 skey 为登录态标识
 */
function getUserInfoBySKey(skey) {
    if (!skey) throw new Error(ERRORS.DBERR.ERR_NO_SKEY_ON_CALL_GETUSERINFOFUNCTION)

    return mysql('user').select('*').where({
        skey
    })
}

module.exports = {
    saveUserInfo,
    getUserInfoBySKey
}

