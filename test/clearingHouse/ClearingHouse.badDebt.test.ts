import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { BaseToken, TestClearingHouse, TestERC20, TestExchange, UniswapV3Pool, Vault } from "../../typechain"
import { addOrder, b2qExactInput, closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse badDebt", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let exchange: TestExchange
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let lowerTick: number, upperTick: number

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%

        fixture = await loadFixture(createClearingHouseFixture(undefined, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        exchange = fixture.exchange as TestExchange
        vault = fixture.vault
        mockedBaseAggregator = fixture.mockedBaseAggregator
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool

        const initPrice = "100"
        const { maxTick, minTick } = await initMarket(fixture, initPrice, 1000)
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(initPrice.toString(), 6), 0, 0, 0]
        })

        lowerTick = minTick
        upperTick = maxTick

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        await initiateBothTimestamps(clearingHouse)

        // prepare collateral for alice
        const decimals = await collateral.decimals()
        await collateral.mint(alice.address, parseUnits("100000", decimals))
        await deposit(alice, vault, 100000, collateral)

        // prepare collateral for bob
        await collateral.mint(bob.address, parseUnits("100", decimals))
        await deposit(bob, vault, 100, collateral)

        // alice add liquidity
        await addOrder(fixture, alice, "500", "50000", lowerTick, upperTick, false)
    })

    describe("close/reduce position when bad debt", () => {
        describe("taker has long position and market price becomes lower than index price", async () => {
            beforeEach(async () => {
                // bob long base Token with 8x leverage
                // bob open notional: -800
                // bob position size: 7.866
                await q2bExactInput(fixture, bob, "800", baseToken.address)
                // market price = index price = 103.222
                await syncIndexToMarketPrice(mockedBaseAggregator, pool)

                // alice short base token that causing bob has bad debt(if he close his position)
                await b2qExactInput(fixture, alice, "5000", baseToken.address)

                // bob's account value is greater than 0 bc it's calculated by index price
                // bob's account value: 100 + 7.866 * 103.222 - 800 = 111.944

                expect(await clearingHouse.getAccountValue(bob.address)).to.be.eq("111974414000000000000")

                // to avoid over maxTickCrossedPerBlock
                await forwardBothTimestamps(clearingHouse, 100)
            })

            it("cannot close position when user has bad debt", async () => {
                // bob close position
                // exchanged notional: 6.510
                // realized PnL: 6.510 - 800 = -793.490
                // account value: 100 - 800 + 6.510 = -693.49 (bad debt)
                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_NEMRM")
            })

            it("cannot reduce position when user has bad debt", async () => {
                // bob short 2 ETH to reduce position
                // exchanged notional: 1.655
                // realized PnL: 1.655 - 2/7.866 * 800 = -201.7520684
                // account value: 100 + 5.866 * 103.222 - 800 + 1.65 = -92.850 (bad debt)
                await expect(b2qExactInput(fixture, bob, "2", baseToken.address)).to.be.revertedWith("CH_NEMRM")
            })

            it("can reduce when not resulting bad debt and has enough collateral", async () => {
                // bob short 0.1 ETH to reduce position
                // exchanged notional: 0.083
                // bob's realized PnL: 0.083 - 0.1/7.866 * 800 = -10.087
                // bob's account value: 100 + 7.766 * 103.222 - 800 + 0.083 = 101.705 (no bad debt)
                // bob's free collateral: 100 - 10.087 - (800 - 0.083 + 10.087) * 10% = 8.9126 > 0
                await expect(b2qExactInput(fixture, bob, "0.1", baseToken.address)).to.emit(
                    clearingHouse,
                    "PositionChanged",
                )
            })

            it("cannot close position with partial close when trader has bad debt", async () => {
                // set max price impact to 0.1% to trigger partial close
                await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 10)

                // partial close bob's position: 7.866 * 25% = 1.88784
                // exchanged notional: 1.629
                // realized PnL: 1.629 - 800 * 0.25 = -198.371
                // account value: 100 + 7.866 * 75% * 103.222 - 800 + 1.629 = -89.413 (bad debt)
                await expect(closePosition(fixture, bob)).to.be.revertedWith("CH_NEMRM")
            })
        })

        describe("taker has long position and index price becomes lower than market price", async () => {
            beforeEach(async () => {
                // bob long base Token with 8x leverage
                // bob position size: 7.866
                await q2bExactInput(fixture, bob, "800", baseToken.address)

                // index price becomes lower than market price, bob has bad debt(calc by index price)
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("10", 6), 0, 0, 0]
                })
            })

            // trader can close position even when his margin ratio is negative as long as he does not incur bad debt
            it("can close position when taker has bad debt(calc by index price) but actually not(calc by market price)", async () => {
                await closePosition(fixture, bob)
            })

            // on the contrary, the trader might not be able to reduce position because
            // the remaining position might still incur bad debt due to the bad index price
            it("cannot reduce position when taker has bad debt(calc by index price) but actually not(calc by market price)", async () => {
                // bob short 1 ETH to reduce position
                // exchanged notional: 103.013
                // realized PnL: 103.013 - 1/7.866 * 800 = 1.20991652
                // account value: 100 + 6.866 * 10 - 800 + 103.013 = -528.327 (bad debt)
                await expect(b2qExactInput(fixture, bob, "1", baseToken.address)).to.be.revertedWith("CH_NEMRM")
            })
        })
    })
})
