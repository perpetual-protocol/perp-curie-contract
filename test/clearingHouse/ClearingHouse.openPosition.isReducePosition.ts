import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { AccountBalance, BaseToken, Exchange, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { addOrder, b2qExactInput, q2bExactOutput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse isIncreasePosition when trader is both of maker and taker", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        exchange = fixture.exchange
        accountBalance = fixture.accountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        const initPrice = "10"
        const { maxTick, minTick } = await initMarket(fixture, initPrice)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        lowerTick = minTick
        upperTick = maxTick

        await collateral.mint(alice.address, parseUnits("3000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)

        await collateral.mint(bob.address, parseUnits("3000", collateralDecimals))
        await deposit(bob, vault, 1000, collateral)

        await collateral.mint(carol.address, parseUnits("3000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
    })

    describe("trader is both of maker and taker", async () => {
        it("reduce taker long position", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 100, 10000, lowerTick, upperTick)

            // bob swap let alice has maker position
            // alice maker positionSize : -1
            await q2bExactOutput(fixture, bob, 1)

            // alice swap
            // alice maker positionSize : -2
            // alice taker positionSize : 1
            // taker open notional will be: -10307153164296021439
            await q2bExactOutput(fixture, alice, 1)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("1"),
            )

            // bob swap to let alice taker position pnl > 0
            // alice maker positionSize : -3
            // alice taker positionSize : 1
            await q2bExactOutput(fixture, bob, 1)

            // alice reduce position
            // alice maker positionSize : -2.5
            // alice taker positionSize : 0.5
            const tx = await b2qExactInput(fixture, alice, 0.5)
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                alice.address,
                baseToken.address,
                parseEther("-0.5"),
                "5286809410520750726",
                "52868094105207508",
                "-5205632911260616889",
                "28308405154926330", // 5.181884987302938(deltaQuote) - 10.307153164296021439(old taker open notional) * 0.5 = 0.028308405154926330
                "256965588076972237113143126655",
            )
            await expect(tx).to.emit(accountBalance, "PnlRealized").withArgs(alice.address, "28308405154926330")

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("0.5"),
            )

            // total position size = taker position size + maker position size
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                parseEther("-2"),
                1,
            )
        })

        it("reduce taker short position", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 100, 10000, lowerTick, upperTick)

            // bob swap let alice has maker position

            // alice maker positionSize : -1
            await q2bExactOutput(fixture, bob, 1)

            // alice swap
            // alice maker positionSize : 0
            // alice taker positionSize : -1
            // taker open notional will be: 10.101010101
            await b2qExactInput(fixture, alice, 1)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("-1"),
            )

            // alice reduce position
            // alice maker positionSize : -0.5
            // alice taker positionSize : -0.5
            const tx = await q2bExactOutput(fixture, alice, 0.5)
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                alice.address,
                baseToken.address,
                parseEther("0.5"),
                "-5025125628140703518",
                "50758844728693975",
                "5000000000000000000",
                "-75884472869397494", // -5.3517471060799995(deltaQuote) + 10.8552631579(old taker open notional) * 0.5 = -0.07588447287
                "251800450628188875564018462374",
            )
            await expect(tx).to.emit(accountBalance, "PnlRealized").withArgs(alice.address, "-75884472869397494")

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("-0.5"),
            )

            // total position size = taker position size + maker position size
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                parseEther("-1"),
                1,
            )
        })

        it("force error, reduce taker position and partial close when excess price limit", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 20, 1000, lowerTick, upperTick)
            // max tick crossed: 1774544, current tick: 23027

            // mock index price higher to let taker open long position (will test reduce taker long position)
            await mockIndexPrice(mockedPriceFeedDispatcher, "40")

            // bob swap let alice has maker position
            // alice maker positionSize : -9
            // alice taker positionSize: 0
            await q2bExactOutput(fixture, bob, 9)
            //  max tick crossed: 1774544, current tick: 34984

            // alice swap
            // alice maker positionSize : -10
            // alice taker positionSize : 1
            await q2bExactOutput(fixture, alice, 1)
            // max tick crossed: 1774544, current tick: 36890

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("1"),
            )

            // set MaxTickCrossedWithinBlock so that trigger over price limit
            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 250)
            // max tick crossed: 250, current tick: 36890

            // expect revert due to over price limit
            // alice reduce taker position
            await expect(b2qExactInput(fixture, alice, 0.5)).to.be.revertedWith("EX_OPLAS")
        })
    })
})
