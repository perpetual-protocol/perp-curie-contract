import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { AccountBalance, BaseToken, Exchange, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { addOrder, b2qExactInput, b2qExactOutput, q2bExactOutput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
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
        mockedPriceFeedDispatcher.smocked.getDispatchedPrice.will.return.with(async () => {
            return parseEther(initPrice)
        })

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
            // alice maker positionSize : -5
            await q2bExactOutput(fixture, bob, 5)

            // alice swap
            // alice maker positionSize : -6
            // alice taker positionSize : 1
            // taker open notional will be: -11311321501691042565
            await q2bExactOutput(fixture, alice, 1)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("1"),
            )

            // bob swap to let alice taker position pnl > 0
            // alice maker positionSize : -7
            // alice taker positionSize : 1
            await q2bExactOutput(fixture, bob, 1)

            // alice reduce position
            // alice maker positionSize : -6.5
            // alice taker positionSize : 0.5
            const tx = await b2qExactInput(fixture, alice, 0.5)
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                alice.address,
                baseToken.address,
                parseEther("-0.5"),
                "5750100626760968316",
                "57501006267609684",
                "-5655660750845521283",
                "36938869647837350", // 5692599620493358632(deltaQuote) - 11311321501691042565(old taker open notional) * 0.5 = 3.693886965E16
                "267958768315559284688164142991",
            )
            await expect(tx).to.emit(accountBalance, "PnlRealized").withArgs(alice.address, "36938869647837350")

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("0.5"),
            )

            // total position size = taker position size + maker position size
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                parseEther("-6"),
                1,
            )
        })

        it("reduce taker short position", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 100, 10000, lowerTick, upperTick)

            // bob swap let alice has maker position

            // alice maker positionSize : -5
            await q2bExactOutput(fixture, bob, 5)

            // alice swap
            // alice maker positionSize : -4
            // alice taker positionSize : -1
            // taker open notional will be: 10855263157894736841
            await b2qExactInput(fixture, alice, 1)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("-1"),
            )

            // alice reduce position
            // alice maker positionSize : -4.5
            // alice taker positionSize : -0.5
            const tx = await q2bExactOutput(fixture, alice, 0.5)
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                alice.address,
                baseToken.address,
                parseEther("0.5"),
                "-5453752181500872601",
                "55088405873746188",
                "5427631578947368421",
                "-81209008427250369", // -5508840587374618789(deltaQuote) + 10855263157894736841(old taker open notional) * 0.5 = -8.12090084e16
                "262347066361306734224496029540",
            )
            await expect(tx).to.emit(accountBalance, "PnlRealized").withArgs(alice.address, "-81209008427250369")

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("-0.5"),
            )

            // total position size = taker position size + maker position size
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                parseEther("-5"),
                1,
            )
        })

        it("force error, reduce taker position and partial close when excess price limit", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 20, 1000, lowerTick, upperTick)

            // bob swap let alice has maker position
            // alice maker positionSize : -10
            // alice taker positionSize: 0
            await q2bExactOutput(fixture, bob, 10)

            // alice swap
            // alice maker positionSize : -15
            // alice taker positionSize : 5
            await q2bExactOutput(fixture, alice, 5)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("5"),
            )

            // set MaxTickCrossedWithinBlock so that trigger over price limit
            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 1000)
            // expect revert due to over price limit
            // alice reduce position
            await expect(b2qExactOutput(fixture, alice, 5)).to.be.revertedWith("EX_OPLBS")
        })
    })
})
