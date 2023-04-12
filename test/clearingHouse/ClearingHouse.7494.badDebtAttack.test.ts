import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { formatEther, formatUnits, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { formatSqrtPriceX96ToPrice, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse 7494 bad debt attack", () => {
    const [admin, maker, account1, account2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%
        const exFeeRatio = 1000 // 0.1%
        const ifFeeRatio = 100000 // 10%

        fixture = await loadFixture(createClearingHouseFixture(undefined, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        // simulating SAND pool
        const initPrice = "1.3"
        const { maxTick, minTick } = await initMarket(fixture, initPrice, exFeeRatio, ifFeeRatio, 250)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        // prepare collateral for makers
        const makerAmount = parseUnits("500000", collateralDecimals)
        await collateral.mint(maker.address, makerAmount) //
        await deposit(maker, vault, 500000, collateral)
        // add a full range liquidity
        await addOrder(fixture, maker, 1500000, 500000, minTick, maxTick)

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
    })

    function getLatestTickBelowPrice(price: number, curTick: number) {
        const getBaseLog = (x: number, y: number) => Math.log(y) / Math.log(x)
        let tick = getBaseLog(1.0001, price)
        tick = Math.round(Math.round(tick) / 10) * 10 // tick space is 10
        while (tick > curTick) {
            tick -= 10
        }
        return tick
    }

    async function getMarketPrice(): Promise<number> {
        const slot0 = await pool.slot0()
        return Number(formatSqrtPriceX96ToPrice(slot0.sqrtPriceX96))
    }

    async function manipulatePrice(endPrice: number) {
        // console.log("===================================== test end price:", endPrice)
        const account1Margin = parseUnits("220000", collateralDecimals)
        await collateral.mint(account1.address, account1Margin)
        await deposit(account1, vault, 220000, collateral)

        // account1 keeps opening long positions and push the price to $4
        let price: number
        let count = 0
        while (true) {
            price = await getMarketPrice()
            if (price >= endPrice) break

            await q2bExactInput(fixture, account1, 6300)

            // forward timestamp to avoid _isOverPriceLimitWithTick
            await forwardBothTimestamps(clearingHouse, 15)
            count++
        }

        // console.log(`txs count: ${count}`)
        const freeCollateralAfterOpenLong = await vault.getFreeCollateral(account1.address)
        const account1MinimalMargin = formatUnits(
            account1Margin.sub(freeCollateralAfterOpenLong).toString(),
            collateralDecimals,
        )
        // console.log(`minimal margin for account1: ${account1MinimalMargin.toString()}`)
    }

    async function testNoProfitAndNoBadDebt() {
        const positionSize = formatEther(
            (await accountBalance.getTakerPositionSize(account1.address, baseToken.address)).toString(),
        )

        const slot0 = await pool.slot0()
        const price = Number(formatSqrtPriceX96ToPrice(slot0.sqrtPriceX96))
        const tick = slot0.tick
        // console.log("===================================== test mark price:", price)

        // account2 deposit margin with amount same to the account1's position notional
        const account2Margin = Math.round(Number(positionSize) * price) / 10 + 10
        // console.log(`minimal margin for account2: ${account2Margin}`)
        const accoun2MarginInWei = parseUnits(account2Margin.toString(), collateralDecimals)
        await collateral.mint(account2.address, accoun2MarginInWei)
        await deposit(account2, vault, account2Margin, collateral)

        const upperTick = getLatestTickBelowPrice(price, tick)
        // account2 add single side liquidity just below the end price

        await addOrder(fixture, account2, 0, account2Margin * 10 - 1, upperTick - 10, upperTick)
        // account1 close position at end price
        await closePosition(fixture, account1)

        // account2 might be in bad debt status
        const account2AccountValue = await vault.getAccountValue(account2.address)
        expect(account2AccountValue).to.be.gte("0")

        // account1's free collateral now greater than account1 & account2's margin
        const account1FreeCollateral = await vault.getFreeCollateral(account1.address)
        // console.log(`account1's free collateral: ${formatUnits(account1FreeCollateral.toString(), collateralDecimals)}`)

        const account1Margin = await vault.getBalance(account1.address)
        const profit = account1FreeCollateral.sub(account1Margin.add(accoun2MarginInWei))
        expect(profit).to.be.lt("0")
        // console.log(`profit: ${formatUnits(profit, collateralDecimals)}`)
    }

    it("end price $1.4 (spread near 10%)", async () => {
        await manipulatePrice(1.4)
        // account 2 has no bad debt
        // account 1 should have no profit
        await testNoProfitAndNoBadDebt()
    })

    it("can not manipulate end price $1.44 (spread more than 10%)", async () => {
        const targetPrice = 1.44
        let isManipulated = true

        try {
            await manipulatePrice(targetPrice)
        } catch (e: any) {
            if (e.message.includes("EX_OPB")) {
                isManipulated = false
            }
        }
        expect(isManipulated).to.eq(false)
        expect(await getMarketPrice()).lt(targetPrice)

        await testNoProfitAndNoBadDebt()
    })
})
