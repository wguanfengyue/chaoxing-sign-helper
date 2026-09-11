# `locationAuthError_LCR007` 调查记录

## 结论

这次失败不是“坐标超出教师设置范围”的典型响应。超星对越界位置常返回 `errorLocation_距离`，而浏览器脚本收到的是 `locationAuthError_LCR007`。结合活动详情和较新的公开客户端实现，最合理的判断是：服务器没有认可这次请求的位置授权上下文。

`LCR007` 的精确服务端含义没有公开文档，下面对根因的判断属于协议对照后的推断，不能冒充超星官方错误码定义。

## 对当前活动的只读核对

- 活动类型为位置签到，服务器记录的开放区间约为 10:00:09 至 10:11:09。
- 截图中的浏览器请求发生在开放区间内，因此“尚未开始”不足以解释错误。
- 活动详情未显示验证码、人脸、微信或公开的防作弊开关。
- 活动详情也未公开固定中心点、经纬度和距离范围。
- 稍后出现的成功记录由手机客户端完成，只能证明账号最终签到成功，不能证明浏览器旧请求的参数有效。

## 新旧流程差异

旧版脚本执行的核心流程很短：

1. 用 GET 请求打开 `newsign/preSign`。
2. 向 `ppt/stuSignajax` 发送活动 ID、姓名、地址和经纬度。

较新的公开实现包含更多上下文：

1. 从活动列表的 `data.ext` 保存活动上下文。
2. 以 POST 表单把 `ext` 交给 `newsign/preSign`，同时携带课程、班级、活动和用户标识。
3. 请求 `pptSign/analysis`，再把返回的动态 code 交给 `analysis2`。
4. 最终请求关联当前账号、机构、活动、位置、设备上下文，以及活动启用的验证码、人脸、照片等参数。

这说明经纬度只是位置签到的一部分。仅修改坐标、地址、`fid=0` 或 `appType=15`，不能补齐整条授权链。

## 3.5.0 的处理方式

脚本不再直接调用旧版位置提交接口。位置活动现在执行以下流程：

1. 读取 `getPPTActiveInfo`，展示服务器公开的位置范围和附加校验。
2. 保存活动列表返回的 `data.ext`。
3. 用户点击后，以 POST 表单把 `ext` 和课程、班级、活动 ID 交给超星官方预签到页。
4. 定位权限、账号授权和最终结果由超星官方网页或学习通客户端处理。

脚本继续负责课表定时检测、通知、活动列表和开放时间检查。保存的地图位置只用于本机核对，不会被伪装成设备 GPS。

## 使用建议

1. 重新安装 3.5.0 后刷新超星页面。
2. 读取活动，点击位置签到的“查看要求并打开官方签到”。
3. 在新标签页允许位置权限，并按超星页面提示完成。
4. 如果官方页面明确要求学习通客户端，直接在手机完成；浏览器继续承担定时检测和提醒。
5. 最终只以超星签到记录为准。网络错误或结果不明时不要连续重复提交。

## 参考实现

- [当前公开实现的接口常量](https://github.com/ASCII-58/chaoxingsignfaker-for-harmony-OS-NEXT/blob/master/entry/src/main/ets/utils/PublicAPI.ts)
- [预签到、行为分析和提交参数实现](https://github.com/ASCII-58/chaoxingsignfaker-for-harmony-OS-NEXT/blob/master/entry/src/main/ets/utils/sign.ets)
- [活动列表 `data.ext` 的读取实现](https://github.com/ASCII-58/chaoxingsignfaker-for-harmony-OS-NEXT/blob/master/entry/src/main/ets/utils/classFun.ets)
- [旧版签到接口说明](https://github.com/MetaQiu/xxtSignApi)
