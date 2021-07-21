import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // mint
        collateral.mint(admin.address, toWei(10000))

        const amount = toWei(1000, await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await collateral.connect(alice).approve(clearingHouse.address, amount)
    })

    describe("# free collateral", () => {
        it("increase free collateral after deposit to vault", async () => {
            const amount = toWei(100, await collateral.decimals())

            await deposit(alice, vault, 100, collateral)

            // check collateral status
            expect(await vault.buyingPower(alice.address)).to.deep.eq(amount)

            // check alice balance
            expect(await collateral.balanceOf(alice.address)).to.eq(toWei(900, await collateral.decimals()))
        })

        // TODO should we test against potential attack using EIP777?
    })

    describe("# mint", () => {
        beforeEach(async () => {
            // prepare collateral
            await deposit(alice, vault, 1000, collateral)

            // add pool
            await clearingHouse.addPool(baseToken.address, 10000)
        })

        // @SAMPLE - mint
        it("alice mint quote and sends an event", async () => {
            // assume imRatio = 0.1
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
            const quoteAmount = toWei(10000, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, quoteToken.address, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await quoteToken.decimals()))
            // verify free collateral = 1000 - 10,000 * 0.1 = 0
            expect(await vault.buyingPower(alice.address)).to.eq(0)
        })

        it("alice mint base and sends an event", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
            const baseAmount = toWei(100, await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - 100 * 100 * 0.1 = 0
            expect(await vault.buyingPower(alice.address)).to.eq(0)
        })

        it("alice mint base twice", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
            const baseAmount = toWei(50, await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - 100 * 100 * 0.1 = 0
            expect(await vault.buyingPower(alice.address)).to.eq(0)
        })

        it("alice mint both and sends an event", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base, 1,0000 quote
            const baseAmount = toWei(100, await baseToken.decimals())
            const quoteAmount = toWei(10000, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, quoteToken.address, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - max(1000 * 10, 10,000) * 0.1 = 0
            expect(await vault.buyingPower(alice.address)).to.eq(0)
        })

        it("alice mint equivalent base and quote", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 50 base, 5000 quote
            const baseAmount = toWei(50, await baseToken.decimals())
            const quoteAmount = toWei(5000, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, quoteToken.address, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - max(500 * 10, 5,000) * 0.1 = 500
            expect(await vault.buyingPower(alice.address)).to.eq(toWei(500, await baseToken.decimals()))
        })

        it("alice mint non-equivalent base and quote", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 50 base, 5000 quote
            const baseAmount = toWei(60, await baseToken.decimals())
            const quoteAmount = toWei(4000, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, quoteToken.address, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(toWei(1000, await baseToken.decimals()))
            // verify free collateral = 1,000 - max(600 * 10, 4,000) * 0.1 = 400
            expect(await vault.buyingPower(alice.address)).to.eq(toWei(400, await baseToken.decimals()))
        })

        // @audit - register is a private method, we don't need to worry about its behavior (@wraecca)
        it("registers each base token once at most", async () => {
            const connectedClearingHouse = clearingHouse.connect(alice)
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 10000 quote once and then mint 50 base twice
            const baseAmount = toWei(50, await baseToken.decimals())
            const quoteAmount = toWei(10000, await quoteToken.decimals())
            await connectedClearingHouse.mint(quoteToken.address, quoteAmount)
            await connectedClearingHouse.mint(baseToken.address, baseAmount)
            await connectedClearingHouse.mint(baseToken.address, baseAmount)

            expect((await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).available).deep.eq(quoteAmount)
            expect((await clearingHouse.getTokenInfo(alice.address, baseToken.address)).available).deep.eq(
                baseAmount.add(baseAmount),
            )
        })

        it("force error, alice mint too many quote", async () => {
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,001 quote
            const quoteAmount = toWei(10001, await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)).to.be.revertedWith(
                "CH_NEAV",
            )
        })

        it("force error, alice mint too many base", async () => {
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,001 quote
            const baseAmount = toWei(101, await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount)).to.be.revertedWith("CH_NEAV")
        })

        it("force error, alice mint without specifying amount", async () => {
            await expect(clearingHouse.connect(alice).mint(baseToken.address, 0)).to.be.revertedWith("CH_IA")
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, 0)).to.be.revertedWith("CH_IA")
        })

        it("force error, alice mint base without specifying baseToken", async () => {
            const baseAmount = toWei(100, await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(EMPTY_ADDRESS, baseAmount)).to.be.revertedWith("CH_TNF")
        })

        it("force error, alice mint base without addPool first", async () => {
            const baseAmount = toWei(100, await baseToken.decimals())
            // collateral: just a random address
            await expect(clearingHouse.connect(alice).mint(collateral.address, baseAmount)).to.be.revertedWith("CH_TNF")
        })
    })
})
