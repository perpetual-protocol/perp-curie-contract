import { expect } from "chai"
import { waffle } from "hardhat"
import { TestClearingHouse } from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse _isReversingPosition", () => {
    const [admin] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
    })

    it("work correctly", async () => {
        // increase/decrease long position
        expect(await clearingHouse.isReversingPosition(1, 2)).to.be.eq(false)
        expect(await clearingHouse.isReversingPosition(2, 1)).to.be.eq(false)
        expect(await clearingHouse.isReversingPosition(0, 1)).to.be.eq(false)
        expect(await clearingHouse.isReversingPosition(1, 0)).to.be.eq(false)
        // increase/decrease short position
        expect(await clearingHouse.isReversingPosition(-2, -1)).to.be.eq(false)
        expect(await clearingHouse.isReversingPosition(-1, -2)).to.be.eq(false)
        expect(await clearingHouse.isReversingPosition(0, -1)).to.be.eq(false)
        expect(await clearingHouse.isReversingPosition(-1, 0)).to.be.eq(false)
        // reverse position
        expect(await clearingHouse.isReversingPosition(1, -1)).to.be.eq(true)
        expect(await clearingHouse.isReversingPosition(-1, 1)).to.be.eq(true)
    })
})
