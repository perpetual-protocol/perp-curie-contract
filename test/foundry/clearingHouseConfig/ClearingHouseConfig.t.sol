pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../interface/IClearingHouseConfigEvent.sol";

contract ClearingHouseConfigTest is IClearingHouseConfigEvent, Setup {
    address notOwner = makeAddr("NotOwner");

    function setUp() public virtual override {
        Setup.setUp();
    }

    function test_setMarketMaxPriceSpreadRatio() public {
        vm.expectEmit(true, true, true, true, address(clearingHouseConfig));
        emit MarketMaxPriceSpreadRatioChanged(address(baseToken), 0.2e6);
        clearingHouseConfig.setMarketMaxPriceSpreadRatio(address(baseToken), 0.2e6);
    }

    function test_revert_setMarketMaxPriceSpreadRatio_when_not_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(notOwner);
        clearingHouseConfig.setMarketMaxPriceSpreadRatio(address(baseToken), 0.2e6);
    }

    function test_getMarketMaxPriceSpreadRatio_when_not_set() public {
        assertEq(uint256(clearingHouseConfig.getMarketMaxPriceSpreadRatio(address(baseToken))), 0.1e6);
    }

    function test_getMarketMaxPriceSpreadRatio_when_set() public {
        clearingHouseConfig.setMarketMaxPriceSpreadRatio(address(baseToken), 0.2e6);
        assertEq(uint256(clearingHouseConfig.getMarketMaxPriceSpreadRatio(address(baseToken))), 0.2e6);
    }

    function test_getMaxPriceSpreadForAddLiquidity() public {
        assertEq(uint256(clearingHouseConfig.getMaxPriceSpreadRatioForAddLiquidity()), 0.1e6);
    }
}
