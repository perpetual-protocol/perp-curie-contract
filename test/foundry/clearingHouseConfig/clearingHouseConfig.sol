pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import { IClearingHouseConfigEvent } from "../interface/IClearingHouseConfigEvent.sol";

contract ClearingHouseConfigTest is IClearingHouseConfigEvent, Setup {
    address public nonOwnerAddress = makeAddr("nonOwnerAddress");

    function setUp() public virtual override {
        Setup.setUp();
    }

    function test_setMarkPriceMarketTwapInterval_should_emit_event(uint32 newMarketTwapInterval) public {
        vm.assume(newMarketTwapInterval != 0);

        (, uint32 premiumIntervalBefore) = clearingHouseConfig.getMarkPriceConfigs();
        vm.expectEmit(true, false, false, true, address(clearingHouseConfig));
        emit MarkPriceMarketTwapIntervalChanged(newMarketTwapInterval);
        clearingHouseConfig.setMarkPriceMarketTwapInterval(newMarketTwapInterval);
        (uint32 marketTwapIntervalAfter, uint32 premiumIntervalAfter) = clearingHouseConfig.getMarkPriceConfigs();
        assertEq(uint256(marketTwapIntervalAfter), newMarketTwapInterval);
        assertEq(uint256(premiumIntervalAfter), premiumIntervalBefore);
    }

    function test_revert_setMarkPriceMarketTwapInterval_if_interval_is_zero() public {
        vm.expectRevert(bytes("CHC_IMPMTI"));
        clearingHouseConfig.setMarkPriceMarketTwapInterval(0);
    }

    function test_revert_setMarkPriceMarketTwapInterval_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        clearingHouseConfig.setMarkPriceMarketTwapInterval(60);
    }

    function test_setMarkPricePremiumInterval_should_emit_event(uint32 newPremiumInterval) public {
        vm.assume(newPremiumInterval != 0);

        (uint32 marketTwapIntervalBefore, ) = clearingHouseConfig.getMarkPriceConfigs();
        vm.expectEmit(true, false, false, true, address(clearingHouseConfig));
        emit MarkPricePremiumIntervalChanged(newPremiumInterval);
        clearingHouseConfig.setMarkPricePremiumInterval(newPremiumInterval);
        (uint32 marketTwapIntervalAfter, uint32 premiumIntervalAfter) = clearingHouseConfig.getMarkPriceConfigs();
        assertEq(uint256(marketTwapIntervalAfter), marketTwapIntervalBefore);
        assertEq(uint256(premiumIntervalAfter), newPremiumInterval);
    }

    function test_revert_setMarkPricePremiumInterval_if_interval_is_zero() public {
        vm.expectRevert(bytes("CHC_IMPPI"));
        clearingHouseConfig.setMarkPricePremiumInterval(0);
    }

    function test_revert_setMarkPricePremiumInterval_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        clearingHouseConfig.setMarkPricePremiumInterval(60);
    }
}
